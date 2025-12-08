/**
 * Capture Processor
 *
 * Process tool outputs into observations with summaries and token estimates.
 */

import { sanitizeContent, estimateTokens } from '../utils/sanitize.js';
import type { Observation } from '../storage/interface.js';

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
 * Short outputs (<= 1500 chars): store full, truncated: false
 * Long outputs: head (800) + "[... N chars omitted ...]" + tail (400), truncated: true
 */
function extractOutput(
  output: string,
  toolName: string,
  toolInput?: unknown
): ExtractedOutput {
  const originalLength = output.length;
  const lineCount = output.split('\n').length;

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
  if (originalLength <= OUTPUT_THRESHOLDS.FULL_STORAGE_LIMIT) {
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
  const head = output.substring(0, OUTPUT_THRESHOLDS.HEAD_SIZE);
  const tail = output.substring(output.length - OUTPUT_THRESHOLDS.TAIL_SIZE);
  const omittedChars = originalLength - OUTPUT_THRESHOLDS.HEAD_SIZE - OUTPUT_THRESHOLDS.TAIL_SIZE;

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
 * Summarize Edit tool
 */
function summarizeEdit(input: Record<string, unknown>, response?: string): string {
  const filePath = input.file_path as string;
  const fileName = filePath.split('/').pop() || filePath;

  // Extract a hint about what changed
  const oldString = (input.old_string as string) || '';
  const newString = (input.new_string as string) || '';

  // Take first line or first 50 chars as hint
  const oldHint = oldString.split('\n')[0]?.substring(0, 50) || '';
  const newHint = newString.split('\n')[0]?.substring(0, 50) || '';

  if (oldHint && newHint) {
    return `Edited ${fileName}: "${oldHint}" → "${newHint}"`;
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

  // Build metadata with enhanced output storage
  const metadata: Record<string, unknown> = {
    tool_input: capture.tool_input,
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
    created_at: new Date().toISOString(),
  };
}
