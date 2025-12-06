/**
 * Transcript Parsing Utilities
 *
 * Parse Claude Code session transcripts to extract "Previously" context.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Convert a project path to dashed format (Claude Code format)
 *
 * Claude Code uses a leading dash before the path:
 *
 * Example:
 *   /Users/username/Projects/Personal/my-project
 *   -> -Users-username-Projects-Personal-my-project
 */
export function convertPathToDashed(projectPath: string): string {
  // Replace all slashes with dashes (keeps leading dash from leading slash)
  return projectPath.replace(/\//g, '-');
}

/**
 * Get the transcript path for a session
 *
 * @param project - Project path
 * @param sessionId - Session ID
 * @returns Full path to transcript JSONL file
 */
export function getTranscriptPath(project: string, sessionId: string): string {
  const dashedPath = convertPathToDashed(project);
  return join(
    homedir(),
    '.claude',
    'projects',
    dashedPath,
    `${sessionId}.jsonl`
  );
}

/**
 * Content block in Claude Code transcript
 */
interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Message structure in Claude Code transcript
 */
interface TranscriptMessage {
  role?: string;
  content?: string | ContentBlock[];
}

/**
 * JSONL entry in Claude Code transcript
 *
 * Claude Code uses this format:
 * {
 *   "type": "assistant",
 *   "message": {
 *     "role": "assistant",
 *     "content": [{ "type": "text", "text": "..." }]
 *   }
 * }
 */
interface TranscriptEntry {
  type?: string;
  message?: TranscriptMessage;
  // Legacy format (direct role/content)
  role?: string;
  content?: string | ContentBlock[];
}

/**
 * Extract text content from message content
 */
function extractTextFromContent(
  content: string | ContentBlock[] | undefined
): string | null {
  if (!content) return null;

  // String content
  if (typeof content === 'string') {
    return content;
  }

  // Array content (content blocks)
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text || '')
      .filter((text) => text.length > 0);

    return textBlocks.length > 0 ? textBlocks.join('\n\n') : null;
  }

  return null;
}

/**
 * Extract text content from a transcript entry
 */
function extractTextContent(entry: TranscriptEntry): string | null {
  // Claude Code format: type="assistant" with nested message
  if (entry.type === 'assistant' && entry.message) {
    return extractTextFromContent(entry.message.content);
  }

  // Legacy format: direct role/content
  if (entry.role === 'assistant') {
    return extractTextFromContent(entry.content);
  }

  return null;
}

/**
 * Check if entry is an assistant message
 */
function isAssistantEntry(entry: TranscriptEntry): boolean {
  // Claude Code format
  if (entry.type === 'assistant') {
    return true;
  }
  // Legacy format
  if (entry.role === 'assistant') {
    return true;
  }
  return false;
}

/**
 * Strip <system-reminder> tags from text
 *
 * These tags contain system-level reminders that shouldn't be shown in context.
 */
export function stripSystemReminderTags(text: string): string {
  let result = '';
  let i = 0;
  const openTag = '<system-reminder>';
  const closeTag = '</system-reminder>';

  while (i < text.length) {
    const remainingLength = text.length - i;

    // Check for opening tag
    if (
      remainingLength >= openTag.length &&
      text.substring(i, i + openTag.length) === openTag
    ) {
      // Find matching close tag
      const closeIndex = text.indexOf(closeTag, i + openTag.length);

      if (closeIndex !== -1) {
        // Skip entire system-reminder section
        i = closeIndex + closeTag.length;
        continue;
      }
    }

    // Copy character if not in system-reminder section
    result += text[i];
    i++;
  }

  return result.trim();
}

/**
 * Parse a transcript file and extract the last assistant message
 *
 * @param transcriptPath - Path to JSONL transcript file
 * @returns Last assistant message text, or null if not found
 */
export function parseTranscriptForLastMessage(
  transcriptPath: string
): string | null {
  if (!existsSync(transcriptPath)) {
    return null;
  }

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);

    // Iterate in reverse to find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;

      try {
        const entry = JSON.parse(line) as TranscriptEntry;

        // Look for assistant messages (handles both Claude Code and legacy formats)
        if (isAssistantEntry(entry)) {
          const text = extractTextContent(entry);
          if (text && text.length > 0) {
            // Strip system-reminder tags before returning
            return stripSystemReminderTags(text);
          }
        }
      } catch (parseError) {
        // Skip invalid JSON lines
        continue;
      }
    }

    return null;
  } catch (error) {
    // Return null on any error (file not found, permission denied, etc.)
    return null;
  }
}

/**
 * Get the "Previously" context for a project
 *
 * @param project - Project path
 * @param currentSessionId - Current session ID (to avoid reading the current session)
 * @param getRecentSessions - Callback to get recent session IDs from storage
 * @returns "Previously" context text, or null if not found
 */
export async function getPreviouslyContext(
  project: string,
  currentSessionId: string,
  getRecentSessions: (project: string, limit: number) => Promise<
    Array<{ id: string; status: 'active' | 'complete' }>
  >
): Promise<string | null> {
  // Get the most recent completed session (excluding current session)
  const sessions = await getRecentSessions(project, 10);

  const priorSession = sessions.find(
    (s) => s.id !== currentSessionId && s.status === 'complete'
  );

  if (!priorSession) {
    return null;
  }

  // Get transcript path
  const transcriptPath = getTranscriptPath(project, priorSession.id);

  // Parse transcript for last message
  const lastMessage = parseTranscriptForLastMessage(transcriptPath);

  return lastMessage;
}
