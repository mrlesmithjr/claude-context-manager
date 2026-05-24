/**
 * Capture Processor
 *
 * Process tool outputs into observations with summaries and token estimates.
 */

import { sanitizeContent, estimateTokens } from '../utils/sanitize.js';
import type { Observation, ImportanceLevel, ObservationTag } from '../storage/interface.js';

/**
 * Output storage thresholds
 *
 * Optimized based on data analysis:
 * - 864 "huge" observations (200+ tokens) were consuming 67% of tokens
 * - Reduced limits to prioritize summaries over raw output
 */
const OUTPUT_THRESHOLDS = {
  FULL_STORAGE_LIMIT: 800,        // chars - store full if under this (was 1500)
  HEAD_SIZE: 400,                 // chars - first N for long outputs (was 800)
  TAIL_SIZE: 200,                 // chars - last N for long outputs (was 400)
  MAX_STORAGE: 700,               // chars - absolute max stored (was 1600)
} as const;

/**
 * Special output limits for high-volume, low-value-per-byte commands
 * Based on data analysis:
 * - psql: 36% of all tokens, 99% duplication, only 5 sessions use it
 * - ssh: 15K tokens, only 5 sessions, output often verbose logs
 */
const REDUCED_OUTPUT_THRESHOLDS = {
  FULL_STORAGE_LIMIT: 300,        // chars - aggressive truncation
  HEAD_SIZE: 150,                 // chars - keep query/command visible
  TAIL_SIZE: 100,                 // chars - minimal tail
} as const;

/**
 * Check if command should use reduced output limits
 */
function shouldUseReducedLimits(toolName: string, toolInput?: unknown): boolean {
  if (toolName !== 'Bash') return false;

  const input = toolInput as Record<string, unknown> | undefined;
  const command = typeof input?.command === 'string' ? input.command : '';

  // psql queries - high volume, output is usually table data
  if (command.includes('psql')) {
    return true;
  }

  // sqlite3 queries - diagnostic, run-once, low cross-session value
  if (command.includes('sqlite3')) {
    return true;
  }

  // ssh commands with log/cat output - verbose, low cross-session value
  if (command.startsWith('ssh ') && (command.includes(' cat ') || command.includes(' logs '))) {
    return true;
  }

  // pytest output - verbose test results, keep just pass/fail summary
  if (command.includes('pytest') || command.includes('python -m pytest')) {
    return true;
  }

  // npm/node commands with verbose output
  if (command.includes('npm run') && (command.includes('test') || command.includes('build'))) {
    return true;
  }

  // filesystem inspection - ephemeral, no cross-session value
  if (/^(ls|du|df|wc|find)\s/.test(command) || command === 'ls' || command === 'du' || command === 'df') {
    return true;
  }

  // one-off python scripts - usually diagnostic
  if (/^python3?\s+-c\s+/.test(command)) {
    return true;
  }

  return false;
}

/**
 * Tool capture input
 */
export interface ToolCapture {
  session_id: string;
  project: string;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: string;
}

/**
 * Extracted output statistics
 */
export interface OutputStats {
  original_length: number;
  line_count: number;
  truncated: boolean;
  tool_specific?: Record<string, unknown>;
}

/**
 * Extracted output result
 */
export interface ExtractedOutput {
  stored_output: string;
  output_stats: OutputStats;
}

/**
 * Extract files touched from tool input/response
 */
function extractFilesTouched(
  toolName: string,
  toolInput: unknown,
  toolResponse?: string
): string[] {
  const files: string[] = [];

  // Extract from tool input
  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;

    // Common file path fields
    const pathFields = ['file_path', 'path', 'filepath', 'file'];
    for (const field of pathFields) {
      if (typeof input[field] === 'string') {
        files.push(input[field]);
      }
    }

    // Edit tool has old_string/new_string but file_path is the file
    // Glob returns pattern, not files
    // Read/Write typically have file_path
  }

  // For Write/Edit, the file_path is the primary file
  // For Bash, there are no files in the traditional sense
  // For Grep/Glob, we don't store individual matched files (too many)

  return [...new Set(files)]; // Deduplicate
}

/**
 * Extract tool-specific statistics from Bash output
 */
function extractBashStats(output: string): Record<string, unknown> | undefined {
  const stats: Record<string, unknown> = {};

  // Try to extract exit code from output (if present)
  // Common pattern: "exit code: 0" or "Exit code: 1"
  const exitCodeMatch = output.match(/exit\s+code:\s*(\d+)/i);
  if (exitCodeMatch && exitCodeMatch[1]) {
    stats.exit_code = parseInt(exitCodeMatch[1], 10);
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

/**
 * Extract tool-specific statistics from Grep output
 */
function extractGrepStats(output: string, toolInput: unknown): Record<string, unknown> | undefined {
  const stats: Record<string, unknown> = {};

  // Count match lines (files or content lines depending on output_mode)
  const lines = output.split('\n').filter(line => line.trim().length > 0);
  stats.match_count = lines.length;

  return stats;
}

/**
 * Extract tool-specific statistics from Glob output
 */
function extractGlobStats(output: string): Record<string, unknown> | undefined {
  const stats: Record<string, unknown> = {};

  // Count file lines
  const lines = output.split('\n').filter(line => line.trim().length > 0);
  stats.file_count = lines.length;

  return stats;
}

/**
 * Extract output with hybrid storage strategy
 *
 * Uses reduced limits for high-volume commands (psql, ssh logs)
 * Short outputs: store full, truncated: false
 * Long outputs: head + "[... N chars omitted ...]" + tail, truncated: true
 */
function extractOutput(
  output: string,
  toolName: string,
  toolInput?: unknown
): ExtractedOutput {
  const originalLength = output.length;
  const lineCount = output.split('\n').length;

  // Select thresholds based on command type
  const useReduced = shouldUseReducedLimits(toolName, toolInput);
  const thresholds = useReduced ? REDUCED_OUTPUT_THRESHOLDS : OUTPUT_THRESHOLDS;

  // Extract tool-specific stats for all outputs
  let toolSpecific: Record<string, unknown> | undefined;
  switch (toolName) {
    case 'Bash':
      toolSpecific = extractBashStats(output);
      break;
    case 'Grep':
      toolSpecific = extractGrepStats(output, toolInput);
      break;
    case 'Glob':
      toolSpecific = extractGlobStats(output);
      break;
  }

  // Short output: store full
  if (originalLength <= thresholds.FULL_STORAGE_LIMIT) {
    return {
      stored_output: output,
      output_stats: {
        original_length: originalLength,
        line_count: lineCount,
        truncated: false,
        tool_specific: toolSpecific,
      },
    };
  }

  // Long output: head + marker + tail
  const head = output.substring(0, thresholds.HEAD_SIZE);
  const tail = output.substring(output.length - thresholds.TAIL_SIZE);
  const omittedChars = originalLength - thresholds.HEAD_SIZE - thresholds.TAIL_SIZE;

  const storedOutput = `${head}\n[... ${omittedChars} chars omitted ...]\n${tail}`;

  return {
    stored_output: storedOutput,
    output_stats: {
      original_length: originalLength,
      line_count: lineCount,
      truncated: true,
      tool_specific: toolSpecific,
    },
  };
}

/**
 * Summarize Read tool
 */
function summarizeRead(input: Record<string, unknown>, response?: string): string {
  const filePath = input.file_path as string;
  const fileName = filePath.split('/').pop() || filePath;

  // Try to detect file type from extension
  const ext = fileName.split('.').pop()?.toLowerCase();

  let typeHint = '';
  if (ext) {
    const typeMap: Record<string, string> = {
      ts: 'TypeScript',
      js: 'JavaScript',
      py: 'Python',
      md: 'Markdown',
      json: 'JSON',
      yml: 'YAML',
      yaml: 'YAML',
      sql: 'SQL',
      sh: 'Shell script',
      rs: 'Rust',
      go: 'Go',
    };
    typeHint = typeMap[ext] || ext.toUpperCase();
  }

  return `Read ${fileName}${typeHint ? ` (${typeHint})` : ''}`;
}

/**
 * Summarize Write tool
 */
function summarizeWrite(input: Record<string, unknown>, response?: string): string {
  const filePath = input.file_path as string;
  const fileName = filePath.split('/').pop() || filePath;

  // Heuristic: if response mentions "created", it's a new file
  const isNew = response?.toLowerCase().includes('created');

  return `${isNew ? 'Created' : 'Updated'} ${fileName}`;
}

/**
 * Summarize Edit tool — find the most meaningful description of what changed.
 */
function summarizeEdit(input: Record<string, unknown>, response?: string): string {
  const filePath = input.file_path as string;
  const fileName = filePath.split('/').pop() || filePath;

  const oldString = (input.old_string as string) || '';
  const newString = (input.new_string as string) || '';

  if (!oldString && !newString) return `Edited ${fileName}`;

  const oldLines = oldString.split('\n').map(l => l.trim()).filter(Boolean);
  const newLines = newString.split('\n').map(l => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const addedLines = newLines.filter(l => !oldSet.has(l));
  const removedLines = oldLines.filter(l => !newSet.has(l));

  // Look for high-signal patterns in added lines
  for (const line of addedLines) {
    const funcMatch = line.match(/(?:function|async function|class|const|export)\s+(\w+)/);
    if (funcMatch) return `Edited ${fileName}: Added ${funcMatch[0].substring(0, 50)}`;

    const importMatch = line.match(/import\s+.+from\s+['"](.+?)['"]/);
    if (importMatch) return `Edited ${fileName}: Added import from '${importMatch[1]}'`;

    const typeMatch = line.match(/(?:interface|type)\s+(\w+)/);
    if (typeMatch) return `Edited ${fileName}: Added ${typeMatch[0]}`;

    if (line.includes('CREATE TABLE') || line.includes('ALTER TABLE')) {
      return `Edited ${fileName}: Schema ${line.substring(0, 50)}`;
    }
  }

  // Summarize by net size of change
  const netLines = newLines.length - oldLines.length;
  if (netLines > 3) return `Edited ${fileName}: Added ~${netLines} lines`;
  if (netLines < -3) return `Edited ${fileName}: Removed ~${Math.abs(netLines)} lines`;

  // Find the first line that actually differs (skip shared prefix lines)
  if (addedLines.length > 0) {
    const hint = addedLines[0]!.substring(0, 60);
    if (hint.length >= 8 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Edited ${fileName}: ${hint}`;
    }
  }
  if (removedLines.length > 0) {
    const hint = removedLines[0]!.substring(0, 60);
    if (hint.length >= 8 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Edited ${fileName}: Changed ${hint}`;
    }
  }

  return `Edited ${fileName}`;
}

/**
 * Summarize Bash tool
 */
function summarizeBash(input: Record<string, unknown>, response?: string): string {
  const command = (input.command as string) || '';

  // Truncate long commands
  const commandPreview = command.length > 60 ? command.substring(0, 60) + '...' : command;

  // Check for common patterns
  if (command.startsWith('git ')) {
    return `Git: ${commandPreview.substring(4)}`;
  }

  if (command.startsWith('npm ') || command.startsWith('yarn ')) {
    return `Package manager: ${commandPreview}`;
  }

  if (command.startsWith('make ')) {
    return `Make: ${commandPreview.substring(5)}`;
  }

  return `Bash: ${commandPreview}`;
}

/**
 * Summarize Grep tool
 */
function summarizeGrep(input: Record<string, unknown>, response?: string): string {
  const pattern = (input.pattern as string) || '';
  const path = (input.path as string) || '.';
  const outputMode = (input.output_mode as string) || 'files_with_matches';

  const patternPreview = pattern.length > 30 ? pattern.substring(0, 30) + '...' : pattern;

  if (outputMode === 'count') {
    return `Grep count: "${patternPreview}" in ${path}`;
  }

  return `Grep: "${patternPreview}" in ${path}`;
}

/**
 * Summarize Glob tool
 */
function summarizeGlob(input: Record<string, unknown>, response?: string): string {
  const pattern = (input.pattern as string) || '';
  const path = (input.path as string) || '.';

  return `Glob: "${pattern}" in ${path}`;
}

/**
 * Summarize tool invocation
 */
function summarizeTool(
  toolName: string,
  toolInput: unknown,
  toolResponse?: string
): string {
  // Default summary
  let summary = `${toolName} tool invocation`;

  if (!toolInput || typeof toolInput !== 'object') {
    return summary;
  }

  const input = toolInput as Record<string, unknown>;

  switch (toolName) {
    case 'Read':
      summary = summarizeRead(input, toolResponse);
      break;

    case 'Write':
      summary = summarizeWrite(input, toolResponse);
      break;

    case 'Edit':
      summary = summarizeEdit(input, toolResponse);
      break;

    case 'Bash':
      summary = summarizeBash(input, toolResponse);
      break;

    case 'Grep':
      summary = summarizeGrep(input, toolResponse);
      break;

    case 'Glob':
      summary = summarizeGlob(input, toolResponse);
      break;

    default:
      // Generic summary
      summary = `${toolName} invocation`;
  }

  return summary;
}

/**
 * Check if an Edit tool input is a version bump (low signal for export)
 */
function isVersionBumpEdit(input: Record<string, unknown>): boolean {
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  if (!oldStr || !newStr) return false;

  const versionPattern = /["']?version["']?\s*[:=]\s*["']?\d+\.\d+\.\d+/;
  if (versionPattern.test(oldStr) && versionPattern.test(newStr)) {
    const normalize = (s: string) => s.replace(/\d+\.\d+\.\d+/g, 'X.X.X').trim();
    return normalize(oldStr) === normalize(newStr);
  }
  return false;
}

function isNearNoOpEdit(input: Record<string, unknown>): boolean {
  const oldStr = typeof input.old_string === 'string' ? input.old_string : '';
  const newStr = typeof input.new_string === 'string' ? input.new_string : '';
  if (!oldStr && !newStr) return false;
  // Pure whitespace/formatting change — same content, different spacing
  if (oldStr.replace(/\s/g, '') === newStr.replace(/\s/g, '')) return true;
  // Comment-only additions
  const oldLines = oldStr.split('\n').map(l => l.trim()).filter(Boolean);
  const newLines = newStr.split('\n').map(l => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const addedLines = newLines.filter(l => !oldSet.has(l));
  if (addedLines.length === 0) return true;
  return addedLines.every(l => /^(\/\/|#|\/\*|\*|\*\/)/.test(l));
}

// --- Tag inference ---

const TAG_FILE_RULES: Array<{ patterns: RegExp[]; tag: ObservationTag }> = [
  {
    tag: 'auth',
    patterns: [
      /\/auth\//i, /\/authentication\//i, /\/authorization\//i,
      /auth\.(ts|js|py|go|rs)$/i, /login\.(ts|js|py|go|rs)$/i,
      /session\.(ts|js|py|go|rs)$/i, /jwt\.(ts|js|py|go|rs)$/i,
      /oauth/i, /token/i, /credential/i, /password/i,
      /ssh_config$/i, /\.pem$/i, /\.key$/i,
    ],
  },
  {
    tag: 'database',
    patterns: [
      /sqlite/i, /postgres/i, /mysql/i, /mongodb/i,
      /\/db\//i, /\/database\//i,
      /schema\.(ts|js|py|sql)$/i, /migration/i,
      /\.sql$/i, /query\.(ts|js|py)$/i,
    ],
  },
  {
    tag: 'testing',
    patterns: [
      /\.test\./i, /\.spec\./i, /__tests__\//i,
      /\/test\//i, /\/tests\//i, /\/e2e\//i,
    ],
  },
  {
    tag: 'git',
    patterns: [
      /\.gitignore$/i, /\.gitattributes$/i, /\.gitmodules$/i,
    ],
  },
  {
    tag: 'infra',
    patterns: [
      /Dockerfile$/i, /docker-compose/i, /\.github\//i,
      /\/k8s\//i, /\/kubernetes\//i, /\/ansible\//i,
      /\/terraform\//i, /\.tf$/i, /\.yml$/, /\.yaml$/,
      /\/molecule\//i, /ansible\.cfg$/i,
    ],
  },
  {
    tag: 'config',
    patterns: [
      /package\.json$/, /tsconfig/i, /pyproject\.toml$/,
      /Makefile$/, /\.env(\.\w+)?$/, /webpack\.config\./,
      /vite\.config\./, /eslint/, /prettier/, /Cargo\.toml$/,
      /go\.mod$/, /requirements.*\.txt$/, /setup\.py$/,
    ],
  },
  {
    tag: 'frontend',
    patterns: [
      /\/web\//i, /\/client\//i, /\/ui\//i, /\/components\//i,
      /\.html$/, /\.css$/, /\.scss$/, /\.tsx$/, /\.vue$/, /\.svelte$/,
    ],
  },
  {
    tag: 'api',
    patterns: [
      /\/api\//i, /\/routes\//i, /\/handlers\//i, /\/endpoints\//i,
      /router\.(ts|js|py|go)$/i, /server\.(ts|js|py|go)$/i,
      /\.http$/, /openapi/, /swagger/,
    ],
  },
];

const TAG_BASH_RULES: Array<{ pattern: RegExp; tag: ObservationTag }> = [
  { tag: 'git',     pattern: /^git\s+/ },
  { tag: 'git',     pattern: /^gh\s+(pr|issue|repo|release|run|workflow|auth|gist)\b/ },
  { tag: 'build',   pattern: /\b(npm\s+(run\s+)?build|tsc\b|cargo\s+build|go\s+build|make\b|uv\s+build)\b/ },
  { tag: 'testing', pattern: /\b(npm\s+(run\s+)?test|pytest\b|cargo\s+test|go\s+test|jest\b|vitest\b)\b/ },
  { tag: 'deps',    pattern: /\b(npm\s+install|npm\s+i\b|yarn\s+add|pip\s+install|pip3\s+install|cargo\s+add|go\s+get|uv\s+add|uv\s+install|poetry\s+add|poetry\s+install)\b/ },
  { tag: 'build',   pattern: /\buv\s+run\b/ },
  { tag: 'infra',   pattern: /\b(docker\s+(build|run|compose|push|pull|tag)|kubectl\b|helm\b|terraform\b)\b/ },
  { tag: 'infra',   pattern: /\b(ansible-playbook\b|ansible-galaxy\b|ansible\b)\b/ },
];

/**
 * Infer domain tags from file paths and Bash command.
 * Tags are additive — a single observation can have multiple.
 */
export function inferTags(
  toolName: string,
  files: string[],
  command?: string,
): ObservationTag[] {
  const tags = new Set<ObservationTag>();

  // File path rules apply to all tools
  for (const file of files) {
    for (const rule of TAG_FILE_RULES) {
      if (rule.patterns.some(p => p.test(file))) {
        tags.add(rule.tag);
      }
    }
  }

  // Bash command rules
  if (toolName === 'Bash' && command) {
    for (const rule of TAG_BASH_RULES) {
      if (rule.pattern.test(command)) {
        tags.add(rule.tag);
      }
    }
  }

  return [...tags];
}

// --- Importance scoring ---

/**
 * Config file patterns that get an importance boost
 */
const CONFIG_FILE_PATTERNS = [
  /package\.json$/,
  /tsconfig.*\.json$/,
  /docker-compose\.ya?ml$/,
  /Dockerfile$/,
  /\.env(\.\w+)?$/,
  /webpack\.config\./,
  /vite\.config\./,
  /eslint/,
  /prettier/,
  /Makefile$/,
  /Cargo\.toml$/,
  /go\.mod$/,
  /pyproject\.toml$/,
  /requirements.*\.txt$/,
];

const TEST_FILE_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /__tests__\//,
  /test\//,
];

const LOCK_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
];

/**
 * Calculate importance score for an observation
 *
 * Base scores by tool/pattern, then adjustments for errors, config files, etc.
 * Returns { importance, importance_score }
 */
export function calculateImportance(
  toolName: string,
  toolInput: unknown,
  toolResponse?: string,
  filesTouched?: string[]
): { importance: ImportanceLevel; importance_score: number } {
  let score: number;

  const input = (toolInput && typeof toolInput === 'object')
    ? toolInput as Record<string, unknown>
    : {};
  const command = typeof input.command === 'string' ? input.command : '';

  // Base score by tool type
  switch (toolName) {
    case 'Edit': {
      const editInput = toolInput as Record<string, unknown> | undefined;
      if (editInput && isVersionBumpEdit(editInput)) {
        score = 0.40;
      } else if (editInput && isNearNoOpEdit(editInput)) {
        score = 0.15;
      } else {
        score = 0.80;
      }
      break;
    }
    case 'Write':
      score = 0.80;
      break;

    case 'Bash': {
      // Git milestones
      if (/^git\s+(commit|merge|rebase|cherry-pick)\b/.test(command)) {
        score = 0.90;
      }
      // Build/test results — test is higher signal than build
      else if (/\b(npm\s+(run\s+)?test|pytest|cargo\s+test|go\s+test)\b/.test(command)) {
        score = 0.70;
      }
      // Routine builds — lower signal, these happen constantly
      else if (/\b(npm\s+(run\s+)?build|cargo\s+build|make\s+|go\s+build)\b/.test(command)) {
        score = 0.55;
      }
      // Version bumps via CLI
      else if (/\bnpm\s+version\b/.test(command)) {
        score = 0.40;
      }
      // Dependency changes
      else if (/\b(npm\s+install|yarn\s+add|pip\s+install|cargo\s+add|go\s+get)\b/.test(command)) {
        score = 0.75;
      }
      // Git exploratory
      else if (/^git\s+(status|log|diff|show)\b/.test(command)) {
        score = 0.35;
      }
      // cat/head/tail via Bash (if they made it through filters)
      else if (/^(cat|head|tail)\s+/.test(command)) {
        score = 0.20;
      }
      // Filesystem inspection - ephemeral, no cross-session value
      else if (/^(ls|du|df|wc|find)\s/.test(command) || /^(ls|du|df)$/.test(command)) {
        score = 0.20;
      }
      // sqlite3 / psql queries - diagnostic, run-once
      else if (command.includes('sqlite3') || command.includes('psql')) {
        score = 0.35;
      }
      // One-off python scripts - usually diagnostic
      else if (/^python3?\s+-c\s+/.test(command)) {
        score = 0.30;
      }
      // General Bash
      else {
        score = 0.50;
      }
      break;
    }

    case 'Read':
      score = 0.30;
      break;

    case 'Grep':
      score = 0.25;
      break;

    case 'Glob':
      score = 0.20;
      break;

    case 'NotebookEdit':
      score = 0.75;
      break;

    default:
      score = 0.50;
  }

  // Adjustments based on content

  // Error/failure boost: errors are high signal for future sessions
  if (toolResponse) {
    const responseLower = toolResponse.toLowerCase();
    if (
      responseLower.includes('error') ||
      responseLower.includes('failed') ||
      responseLower.includes('exception') ||
      responseLower.includes('fatal')
    ) {
      score += 0.25;
    }
  }

  // File-based adjustments
  const allFiles = [
    ...(filesTouched || []),
    typeof input.file_path === 'string' ? input.file_path : '',
    typeof input.path === 'string' ? input.path : '',
  ].filter(Boolean);

  for (const file of allFiles) {
    // Config file boost
    if (CONFIG_FILE_PATTERNS.some(p => p.test(file))) {
      score += 0.15;
      break; // Only apply once
    }
  }

  for (const file of allFiles) {
    // Test file boost
    if (TEST_FILE_PATTERNS.some(p => p.test(file))) {
      score += 0.10;
      break;
    }
  }

  for (const file of allFiles) {
    // Lock/generated file penalty
    if (LOCK_FILE_PATTERNS.some(p => p.test(file))) {
      score -= 0.30;
      break;
    }
  }

  // Clamp to [0.0, 1.0]
  score = Math.max(0.0, Math.min(1.0, score));

  // Determine level
  let importance: ImportanceLevel;
  if (score >= 0.65) {
    importance = 'high';
  } else if (score >= 0.35) {
    importance = 'medium';
  } else {
    importance = 'low';
  }

  return { importance, importance_score: Math.round(score * 100) / 100 };
}

/**
 * Process a tool capture into an observation
 */
export function processToolCapture(capture: ToolCapture): Omit<Observation, 'id'> {
  // Sanitize tool response
  const sanitizedResponse = capture.tool_response
    ? sanitizeContent(capture.tool_response)
    : '';

  // Extract output with hybrid storage strategy
  const extracted = extractOutput(
    sanitizedResponse,
    capture.tool_name,
    capture.tool_input
  );

  // Generate summary
  const summary = summarizeTool(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse
  );

  // Extract files touched
  const filesTouched = extractFilesTouched(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse
  );

  // Estimate tokens for summary + stored output
  const contentToEstimate = `${summary}\n${extracted.stored_output}`;
  const tokenEstimate = estimateTokens(contentToEstimate);

  // Calculate importance score
  const { importance, importance_score } = calculateImportance(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse,
    filesTouched
  );

  // Infer domain tags from file paths and command
  const command = (capture.tool_input && typeof capture.tool_input === 'object')
    ? (capture.tool_input as Record<string, unknown>).command as string | undefined
    : undefined;
  const tags = inferTags(capture.tool_name, filesTouched, command);

  // Build metadata with enhanced output storage.
  // Strip large/sensitive fields from tool_input for Edit and Write — the summary
  // already captures the meaningful diff, and old_string/new_string/content may
  // contain secrets that are not matched by SENSITIVE_PATTERNS.
  const sanitizedToolInput = capture.tool_input
    ? { ...(capture.tool_input as Record<string, unknown>) }
    : undefined;
  if (sanitizedToolInput) {
    if (capture.tool_name === 'Edit' || capture.tool_name === 'Write') {
      delete sanitizedToolInput['old_string'];
      delete sanitizedToolInput['new_string'];
      delete sanitizedToolInput['content'];
    }
  }
  const metadata: Record<string, unknown> = {
    tool_input: sanitizedToolInput,
    stored_output: extracted.stored_output,
    output_stats: extracted.output_stats,
  };

  return {
    session_id: capture.session_id,
    project: capture.project,
    tool_name: capture.tool_name,
    summary,
    files_touched: filesTouched,
    metadata,
    token_estimate: tokenEstimate,
    importance,
    importance_score,
    tags: tags.length > 0 ? tags : undefined,
    created_at: new Date().toISOString(),
  };
}
