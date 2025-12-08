/**
 * Input Validation Utilities
 *
 * Validates hook inputs and project paths for security.
 */

import { realpathSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

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
  path.join(homedir(), 'Obsidian'),  // Obsidian vaults
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
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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

  // cwd is optional - use process.cwd() if not provided
  const rawCwd = (typeof obj.cwd === 'string' && obj.cwd.length > 0)
    ? obj.cwd
    : process.cwd();

  // Try to validate project path, but don't fail if outside allowed roots
  // (just use the raw cwd - we'll skip storage for non-project directories)
  let validatedCwd: string;
  try {
    validatedCwd = validateProjectPath(rawCwd);
  } catch {
    // Path outside allowed roots - use raw path anyway
    // The storage layer can handle this gracefully
    validatedCwd = rawCwd;
  }

  return {
    session_id,
    cwd: validatedCwd,
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

  // Validate project path
  const validatedCwd = validateProjectPath(obj.cwd);

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

  // Validate project path
  const validatedCwd = validateProjectPath(obj.cwd);

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    transcript_path:
      typeof obj.transcript_path === 'string' ? obj.transcript_path : undefined,
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

  // Validate project path
  const validatedCwd = validateProjectPath(obj.cwd);

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
    // Add more low-value tools as needed
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
      /^cd\s+.*&&\s*(echo|ls\s+-la?\s*$)/, // cd && echo or cd && ls (low value)
      /^pwd$/,                            // Current directory
      /^ls\s+-la?\s*$/,                   // Basic ls without path
      /^echo\s+['"]?DISPATCHER/i,         // Dispatcher protocol messages
      /^echo\s+['"]?<user-prompt/i,       // User prompt hook messages
      /^echo\s+['"]?(Success|===)/i,      // Status echo messages
      /^clear$/,                          // Clear screen
      /^history/,                         // History commands
      /^which\s+/,                        // Which commands
      /^type\s+/,                         // Type commands
    ];

    for (const pattern of SKIP_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return false;
      }
    }
  }

  return true;
}
