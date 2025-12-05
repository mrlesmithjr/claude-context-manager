/**
 * Capture Processor
 *
 * Process tool outputs into observations with summaries and token estimates.
 */

import { sanitizeContent, estimateTokens } from '../utils/sanitize.js';
import type { Observation } from '../storage/interface.js';

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

  // Estimate tokens for summary + sanitized response preview
  const contentToEstimate = `${summary}\n${sanitizedResponse.substring(0, 500)}`;
  const tokenEstimate = estimateTokens(contentToEstimate);

  // Build metadata
  const metadata: Record<string, unknown> = {
    tool_input: capture.tool_input,
    response_preview: sanitizedResponse.substring(0, 200),
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
