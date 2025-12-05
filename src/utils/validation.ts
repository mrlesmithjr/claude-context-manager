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
  transcript_summary?: string;
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
 * Validate SessionStart input
 */
export function validateSessionStartInput(input: unknown): SessionStartInput {
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

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    tool_name: obj.tool_name,
    tool_input: obj.tool_input,
    tool_response:
      typeof obj.tool_response === 'string' ? obj.tool_response : undefined,
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
    transcript_summary:
      typeof obj.transcript_summary === 'string' ? obj.transcript_summary : undefined,
  };
}

/**
 * Validate UserPromptSubmit input
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

  if (typeof obj.prompt_number !== 'number' || obj.prompt_number < 0) {
    throw new Error('Invalid input: prompt_number must be non-negative number');
  }

  if (typeof obj.prompt !== 'string' || obj.prompt.length === 0) {
    throw new Error('Invalid input: prompt must be non-empty string');
  }

  // Validate project path
  const validatedCwd = validateProjectPath(obj.cwd);

  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    prompt_number: obj.prompt_number,
    prompt: obj.prompt,
  };
}

/**
 * Check if a tool should be captured
 *
 * Some tools are too noisy or low-value to capture.
 */
export function shouldCaptureTool(toolName: string): boolean {
  const SKIP_TOOLS = [
    'TodoWrite',
    'AskUserQuestion',
    'SlashCommand',
    // Add more low-value tools as needed
  ];

  return !SKIP_TOOLS.includes(toolName);
}
