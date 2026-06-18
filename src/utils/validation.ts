/**
 * Input Validation Utilities
 *
 * Validates hook inputs and project paths for security.
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { findProjectRoot } from './find-project-root.js';

/**
 * Allowed project root directories
 *
 * Add common project directories here. The validation will allow
 * any path that starts with one of these roots.
 */
const ALLOWED_PROJECT_ROOTS = [
  path.join(homedir(), 'Projects'),
  path.join(homedir(), 'projects'),
  path.join(homedir(), 'Dev'),
  path.join(homedir(), 'dev'),
  path.join(homedir(), 'Code'),
  path.join(homedir(), 'code'),
  path.join(homedir(), 'Workspace'),
  path.join(homedir(), 'workspace'),
  path.join(homedir(), 'Documents'),  // Common location
  homedir(),  // Allow home directory as fallback
];

/**
 * Validate and normalize a project path
 *
 * @param projectPath - Path to validate
 * @returns Normalized path if valid
 * @throws Error if path is invalid or outside allowed roots
 */
export function validateProjectPath(projectPath: string): string {
  // Normalize and resolve symlinks
  let normalizedPath: string;
  try {
    normalizedPath = realpathSync(projectPath);
  } catch (error) {
    // Path doesn't exist - use path.resolve for normalization
    normalizedPath = path.resolve(projectPath);
  }

  // Check if path is within allowed roots
  const isAllowed = ALLOWED_PROJECT_ROOTS.some((root) => {
    try {
      const normalizedRoot = realpathSync(root);
      return normalizedPath.startsWith(normalizedRoot);
    } catch {
      // Root doesn't exist, skip
      return false;
    }
  });

  if (!isAllowed) {
    throw new Error(
      `Project path outside allowed roots: ${normalizedPath}. Allowed roots: ${ALLOWED_PROJECT_ROOTS.join(', ')}`
    );
  }

  return normalizedPath;
}

/**
 * SessionStart hook input schema
 *
 * All fields are optional - Claude Code may not provide all of them.
 * We fall back to sensible defaults.
 */
export interface SessionStartInput {
  session_id: string;
  cwd: string;
}

/**
 * PostToolUse hook input schema
 */
export interface PostToolUseInput {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input?: unknown;
  tool_response?: string;
}

/**
 * Stop hook input schema
 */
export interface StopInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
}

/**
 * UserPromptSubmit hook input schema
 */
export interface UserPromptSubmitInput {
  session_id: string;
  cwd: string;
  prompt_number: number;
  prompt: string;
}

/**
 * Generate a simple unique ID for sessions when not provided
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${randomBytes(8).toString('hex')}`;
}

/**
 * Validate SessionStart input
 *
 * All input fields are OPTIONAL - Claude Code may send minimal or empty input.
 * We fall back to defaults like claude-mem does.
 */
export function validateSessionStartInput(input: unknown): SessionStartInput {
  const obj = (typeof input === 'object' && input !== null)
    ? input as Record<string, unknown>
    : {};

  // session_id is optional - generate one if not provided
  const session_id = (typeof obj.session_id === 'string' && obj.session_id.length > 0)
    ? obj.session_id
    : generateSessionId();

  // cwd is optional - use process.cwd() if not provided.
  // Preserve the original hook input separately so warning messages can
  // accurately describe what the hook actually sent vs. what cwd() returned.
  const hookCwd = (typeof obj.cwd === 'string' && obj.cwd.length > 0) ? obj.cwd : null;
  const rawCwd = hookCwd ?? process.cwd();

  // Try to validate project path. Fall back to process.cwd() (never raw input)
  // so the prefix-matching storage queries are scoped to the actual process
  // location rather than an untrusted or over-broad path from hook input.
  // Double-failure guard: if process.cwd() is also outside allowed roots
  // (unusual environment), fall back to homedir() which is always in ALLOWED_PROJECT_ROOTS.
  let validatedCwd: string;
  try {
    validatedCwd = validateProjectPath(rawCwd);
  } catch {
    try {
      validatedCwd = validateProjectPath(process.cwd());
    } catch {
      const fallback = homedir();
      const inputDescription = hookCwd ? `'${hookCwd}'` : '(none — hook sent no cwd)';
      console.error(`[context-manager] WARNING: could not validate project path ${inputDescription} or process.cwd(), falling back to home directory. Observations will be scoped to ${fallback}`);
      validatedCwd = fallback;
    }
  }

  return {
    session_id,
    cwd: findProjectRoot(validatedCwd),
  };
}

/**
 * Validate PostToolUse input
 */
export function validatePostToolUseInput(input: unknown): PostToolUseInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid input: expected object');
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.session_id !== 'string' || obj.session_id.length === 0) {
    throw new Error('Invalid input: session_id must be non-empty string');
  }

  if (typeof obj.cwd !== 'string' || obj.cwd.length === 0) {
    throw new Error('Invalid input: cwd must be non-empty string');
  }

  if (typeof obj.tool_name !== 'string' || obj.tool_name.length === 0) {
    throw new Error('Invalid input: tool_name must be non-empty string');
  }

  // Validate project path and normalize to nearest project root
  const validatedCwd = findProjectRoot(validateProjectPath(obj.cwd));

  // Extract tool_response - can be string or object with stdout/stderr
  let toolResponse: string | undefined;
  if (typeof obj.tool_response === 'string') {
    toolResponse = obj.tool_response;
  } else if (typeof obj.tool_response === 'object' && obj.tool_response !== null) {
    const resp = obj.tool_response as Record<string, unknown>;
    // Combine stdout and stderr for full output
    const stdout = typeof resp.stdout === 'string' ? resp.stdout : '';
    const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
    toolResponse = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
  }

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    tool_name: obj.tool_name,
    tool_input: obj.tool_input,
    tool_response: toolResponse,
  };
}

/**
 * Validate Stop input
 */
export function validateStopInput(input: unknown): StopInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid input: expected object');
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.session_id !== 'string' || obj.session_id.length === 0) {
    throw new Error('Invalid input: session_id must be non-empty string');
  }

  if (typeof obj.cwd !== 'string' || obj.cwd.length === 0) {
    throw new Error('Invalid input: cwd must be non-empty string');
  }

  // Validate project path and normalize to nearest project root
  const validatedCwd = findProjectRoot(validateProjectPath(obj.cwd));

  // Validate transcript_path is within the expected Claude projects directory.
  // Use realpathSync (not path.resolve) to follow symlinks before comparing —
  // a symlink inside ~/.claude/projects pointing outside would bypass a lexical check.
  // Reject silently (undefined) rather than throwing — missing transcript is
  // gracefully handled by the caller; a path traversal attempt must not succeed.
  let transcriptPath: string | undefined;
  if (typeof obj.transcript_path === 'string' && obj.transcript_path.length > 0) {
    const expectedRoot = path.resolve(homedir(), '.claude', 'projects');
    try {
      const resolved = realpathSync(obj.transcript_path);
      if (resolved.startsWith(expectedRoot + path.sep)) {
        transcriptPath = resolved;
      }
      // else: path outside expected root — silently drop it
    } catch {
      // realpathSync throws if file does not exist — silently drop it
    }
  }

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    transcript_path: transcriptPath,
  };
}

/**
 * Validate UserPromptSubmit input
 *
 * Claude Code sends: session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt
 * Note: prompt_number is NOT sent by Claude Code, so we make it optional
 */
export function validateUserPromptSubmitInput(input: unknown): UserPromptSubmitInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid input: expected object');
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.session_id !== 'string' || obj.session_id.length === 0) {
    throw new Error('Invalid input: session_id must be non-empty string');
  }

  if (typeof obj.cwd !== 'string' || obj.cwd.length === 0) {
    throw new Error('Invalid input: cwd must be non-empty string');
  }

  // prompt_number is optional - Claude Code doesn't send it
  const promptNumber = typeof obj.prompt_number === 'number' ? obj.prompt_number : 0;

  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    throw new Error('Invalid input: prompt must be non-empty string');
  }

  // Validate project path and normalize to nearest project root
  const validatedCwd = findProjectRoot(validateProjectPath(obj.cwd));

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    prompt_number: promptNumber,
    prompt: obj.prompt,
  };
}

/**
 * Check if a tool should be captured
 *
 * Some tools are too noisy or low-value to capture.
 */
export function shouldCaptureTool(toolName: string, toolInput?: unknown): boolean {
  const SKIP_TOOLS = [
    'TodoWrite',
    'AskUserQuestion',
    'SlashCommand',
    // Meta/orchestration tools - zero cross-session value
    'Task',
    'TaskCreate',
    'TaskUpdate',
    'TaskGet',
    'TaskOutput',
    'TaskList',
    'TaskStop',
    'AgentOutputTool',
    'BashOutput',
    'KillShell',
    // 'Skill' is intentionally NOT skipped (fixes #259): a Skill tool call is a
    // deliberate, named user-directed invocation (tool_input.skill) that
    // context_skill_stats is built to track, unlike the orchestration tools above.
    'EnterPlanMode',
    'ExitPlanMode',
    'EnterWorktree',
  ];

  if (SKIP_TOOLS.includes(toolName)) {
    return false;
  }

  // Check for low-value Bash commands
  if (toolName === 'Bash' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const command = typeof input.command === 'string' ? input.command : '';

    // Skip patterns for repetitive/low-value commands
    // Based on data analysis: cd commands were 25K tokens across 20 sessions
    const SKIP_BASH_PATTERNS = [
      /^cd\s+[^&|;]+$/,                   // Simple cd (no chaining)
      /^cd\s+.+&&/,                       // Any cd && chain (usually just navigation)
      /^pwd$/,                            // Current directory
      /^ls\s+-la?\s*$/,                   // Basic ls without path
      /^ls\s+-la?\s+[^\|]+$/,             // Basic ls with path (no piping)
      /^echo\s+['"]?DISPATCHER/i,         // Dispatcher protocol messages
      /^echo\s+['"]?<user-prompt/i,       // User prompt hook messages
      /^echo\s+['"]?(Success|===|═)/i,    // Status echo messages and banners
      /^echo\s+['"]?\n?═/,                // Banner lines starting with box chars
      /^cat\s*<<\s*['"]?EOF/i,            // Here-docs (usually banner output)
      /^clear$/,                          // Clear screen
      /^history/,                         // History commands
      /^which\s+/,                        // Which commands
      /^type\s+/,                         // Type commands
      /^find\s+/,                         // Find commands (verbose output)
      // Exploratory/read-only commands with low cross-session value
      /^cat\s+/,                          // cat file reads
      /^head\s+/,                         // head file reads
      /^tail\s+/,                         // tail file reads
      /^wc\s+/,                           // Word/line count
      /^file\s+/,                         // File type detection
      /^stat\s+/,                         // File stats
      /^diff\s+/,                         // File diffs (exploratory)
      /^git\s+stash\s+list/,              // Git stash listing
      /^git\s+branch\s*($|\s+-[^dD])/,   // Git branch listing (not delete)
      /^docker\s+(ps|images)\b/,          // Docker listing commands
      /^kubectl\s+get\b/,                 // Kubernetes listing commands
    ];

    for (const pattern of SKIP_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return false;
      }
    }
  }

  // Check for low-value Read targets (generated/vendored files)
  if (toolName === 'Read' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';

    const SKIP_READ_PATTERNS = [
      /\/node_modules\//,                 // Vendored dependencies
      /\/\.git\//,                        // Git internals
      /\/(dist|build|out|\.next)\//,      // Build output directories
      /\/package-lock\.json$/,            // npm lock file
      /\/yarn\.lock$/,                    // Yarn lock file
      /\/pnpm-lock\.yaml$/,              // pnpm lock file
    ];

    for (const pattern of SKIP_READ_PATTERNS) {
      if (pattern.test(filePath)) {
        return false;
      }
    }
  }

  // Check for overly broad Glob patterns
  if (toolName === 'Glob' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';

    const SKIP_GLOB_PATTERNS = [
      /^\*$/,                             // Just "*" - matches everything
      /^\*\.\*$/,                         // "*.*" - matches all files with extensions
    ];

    for (const p of SKIP_GLOB_PATTERNS) {
      if (p.test(pattern)) {
        return false;
      }
    }
  }

  // Check for low-value Edit operations (agent worklog files)
  if (toolName === 'Edit' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';

    // Skip agent worklog/summary files - these are transient artifacts
    // Data analysis: 155+ duplicate summary.md edits in single day
    const SKIP_EDIT_PATTERNS = [
      /\/summary\.md$/,                   // Agent summary files
      /\/worklog\.md$/,                   // Agent worklog files
      /\/\.agent-.*\.md$/,                // Agent temp files
    ];

    for (const pattern of SKIP_EDIT_PATTERNS) {
      if (pattern.test(filePath)) {
        return false;
      }
    }
  }

  return true;
}
