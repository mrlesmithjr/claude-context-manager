/**
 * Transcript Parsing Utilities
 *
 * Parse Claude Code session transcripts to extract "Previously" context.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Convert a project path to dashed format (like claude-mem does)
 *
 * Example:
 *   /Users/username/Projects/Personal/my-project
 *   -> Users-username-Projects-Personal-my-project
 */
export function convertPathToDashed(projectPath: string): string {
  // Remove leading slash and replace remaining slashes with dashes
  return projectPath.replace(/^\//, '').replace(/\//g, '-');
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
 * JSONL entry for assistant message
 */
interface TranscriptEntry {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Extract text content from a transcript entry
 */
function extractTextContent(entry: TranscriptEntry): string | null {
  if (!entry.content) return null;

  // String content
  if (typeof entry.content === 'string') {
    return entry.content;
  }

  // Array content (content blocks)
  if (Array.isArray(entry.content)) {
    const textBlocks = entry.content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text || '')
      .filter((text) => text.length > 0);

    return textBlocks.length > 0 ? textBlocks.join('\n\n') : null;
  }

  return null;
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

        // Look for assistant messages
        if (entry.role === 'assistant') {
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
