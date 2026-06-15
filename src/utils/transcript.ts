/**
 * Transcript Parsing Utilities
 *
 * Parse Claude Code session transcripts to extract "Previously" context,
 * narrative scoring, and session summary selection.
 */

import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
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
 * Decode a Claude Code dashed directory name back to a real filesystem path.
 *
 * Claude Code encodes project paths by replacing every `/` with `-`, producing
 * strings like `-Users-larry-my-project`. The problem: hyphens inside real path
 * segments (e.g., `my-project`) are indistinguishable from path separators.
 *
 * Strategy: greedy filesystem-validated decode. Walk left to right, trying the
 * longest possible segment at each position that exists as a directory on disk.
 * For the root segment (`-Users`) the first character is always the leading `/`
 * separator, so we start from the first `-`-separated token.
 *
 * Returns null if no valid filesystem path could be assembled from the encoded
 * string, or if the encoded string is empty.
 *
 * @param encoded - The dashed directory name (e.g. "-Users-larry-my-project")
 * @returns The decoded absolute path, or null if no match found
 */
export function decodeDashedPath(encoded: string): string | null {
  if (!encoded) return null;

  // The encoded form always starts with a leading `-` that represents `/`.
  // Split on `-` gives ['', 'Users', 'larry', ...]; skip the empty first element.
  const tokens = encoded.split('-');
  if (tokens.length < 2 || tokens[0] !== '') return null;
  if (tokens.some(t => t === '..' || t === '.')) return null;

  // tokens[0] is '' (before the leading '-')
  // We reconstruct by trying to greedily merge consecutive tokens into a single
  // path segment when intermediate hyphens could be part of the segment name.

  function recurse(tokenIndex: number, currentPath: string): string | null {
    // All tokens consumed — we have a complete candidate path
    if (tokenIndex >= tokens.length) {
      return currentPath;
    }

    // Try merging 1..N remaining tokens into the next segment (greedy: longest first)
    const remaining = tokens.length - tokenIndex;
    for (let len = remaining; len >= 1; len--) {
      const segment = tokens.slice(tokenIndex, tokenIndex + len).join('-');
      if (!segment) continue; // skip empty segments (double-hyphen edge cases)

      const candidate = currentPath + '/' + segment;

      // Check if this candidate path exists on disk
      if (existsSync(candidate)) {
        const result = recurse(tokenIndex + len, candidate);
        if (result !== null) return result;
      }
    }

    return null;
  }

  // Start from root: first real token is at index 1 (index 0 is the '' before leading '-')
  // Seed the path at filesystem root '/'
  const result = recurse(1, '');
  return result;
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
  const safeSessionId = basename(sessionId);
  return join(
    homedir(),
    '.claude',
    'projects',
    dashedPath,
    `${safeSessionId}.jsonl`
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
 * JSONL message shape used by the Stop hook and checkpoint runner.
 * Kept minimal: only the fields actually accessed at runtime.
 */
export interface TranscriptLine {
  type: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  summary?: string;
}

/**
 * Extract plain text from a parsed TranscriptLine.
 * Returns empty string when no text content is present.
 */
export function extractTextFromTranscriptLine(msg: TranscriptLine): string {
  const content = msg.message?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('\n');
  }
  return '';
}

/**
 * Score an assistant message for narrative quality.
 * Returns 0.0-1.0 (0 = skip, higher = better narrative candidate).
 * Favors messages that describe completed work rather than in-progress commentary.
 * Also scores discussion and planning sessions via decision, comparison, and conclusion signals.
 */
export function scoreForNarrative(text: string): number {
  if (text.length < 50) return 0;

  const lower = text.toLowerCase().trimStart();

  // Skip short affirmations and confirmations
  if (text.length < 200) {
    if (/^(yes|sure|ok|okay|alright|got it|sounds good|perfect|great|done|correct|right|no problem|will do|absolutely)\b/.test(lower)) return 0;
    if (/^(let me |i'll |i've |checking|looking|reading|searching)/.test(lower)) return 0;
  }

  let score = 0;

  // Length sweet spot: 150-1500 chars
  if (text.length >= 150) score += 0.15;
  if (text.length >= 400) score += 0.10;
  if (text.length > 3000) score -= 0.10; // Long raw dumps make poor narratives

  // Technical/work-describing content
  if (/\b(implement|add|fix|update|creat|refactor|chang|remov|improv|build|replac|rewrit)\w*\b/i.test(text)) score += 0.20;
  if (/\b\w+\.(ts|js|py|yaml|yml|json|md|sql)\b/.test(text)) score += 0.15;
  if (text.includes('```')) score += 0.10;

  // Structured content (bullet lists suggest substantive output)
  const bulletCount = (text.match(/^[-*]\s/gm) || []).length;
  if (bulletCount >= 2) score += 0.10;

  // Slight penalty for responses that end as questions
  if (text.trimEnd().endsWith('?')) score -= 0.10;

  // Decision language: captures planning and advisory sessions
  const decisionPhrases = [
    'decided', 'going with', 'recommendation', 'the approach is',
    'worth building', 'best option', 'the honest assessment',
    'the right answer', 'we will', 'the plan is',
  ];
  if (decisionPhrases.some(p => lower.includes(p))) score += 0.15;

  // Comparison/analysis structure: tables and trade-off language
  const hasMarkdownTable = lower.includes('|---|') || lower.includes('| ---');
  const comparisonPhrases = [' vs ', 'trade-off', 'tradeoff', 'pros and cons', 'honest gap', 'honest answer', 'the gap is'];
  if (hasMarkdownTable || comparisonPhrases.some(p => lower.includes(p))) score += 0.15;

  // Conclusion framing: summary and bottom-line statements
  const conclusionPhrases = [
    'bottom line', 'in order of', 'sequencing', 'the sequenc',
    'in summary', 'to summarize', 'here is what', "here's what",
  ];
  if (conclusionPhrases.some(p => lower.includes(p))) score += 0.10;

  // Priority/planning language: task sequencing and prioritization
  const priorityPhrases = ['tackle first', 'priority', 'next step', 'first step'];
  if (priorityPhrases.some(p => lower.includes(p))) score += 0.05;

  return Math.max(0, Math.min(1.0, score));
}

/**
 * Parse pre-read JSONL lines and pick the best narrative summary for a session.
 *
 * Returns:
 *   summary          - Best single assistant message (capped at 1500 chars)
 *   summaryExtended  - Top-3 messages joined with separators (only when 2+)
 *   bestScore        - Score of the winning candidate (0 when falling back to last message)
 *
 * Used by both session-end.ts (Stop hook) and the checkpoint runner in
 * capture-prompt.ts so narrative scoring logic stays in one place.
 */
export function pickBestNarrative(lines: string[]): {
  summary: string | undefined;
  summaryExtended: string | undefined;
  bestScore: number;
} {
  if (lines.length === 0) return { summary: undefined, summaryExtended: undefined, bestScore: 0 };

  // Check first line for an embedded summary field
  const firstLine = lines[0];
  if (firstLine !== undefined) {
    try {
      const first = JSON.parse(firstLine) as TranscriptLine;
      if (first.summary && typeof first.summary === 'string') {
        return { summary: first.summary, summaryExtended: undefined, bestScore: 1.0 };
      }
    } catch {
      // Not valid JSON or no summary field. Continue.
    }
  }

  const scored: Array<{ text: string; score: number }> = [];
  let lastAssistantContent = '';

  for (const rawLine of lines) {
    try {
      const msg = JSON.parse(rawLine) as TranscriptLine;
      if (msg.type !== 'assistant' || msg.message?.role !== 'assistant') continue;
      const text = extractTextFromTranscriptLine(msg);
      if (!text) continue;
      lastAssistantContent = text;
      scored.push({ text, score: scoreForNarrative(text) });
    } catch {
      continue;
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const qualifying = scored.filter(m => m.score >= 0.25);

  const winner = qualifying.length > 0 ? qualifying[0]! : null;
  const bestText = winner ? winner.text : lastAssistantContent;
  const bestScore = winner ? winner.score : 0;

  if (!bestText) return { summary: undefined, summaryExtended: undefined, bestScore: 0 };

  const summary = bestText.length > 1500 ? bestText.substring(0, 1500) + '...' : bestText;

  let summaryExtended: string | undefined;
  if (qualifying.length >= 2) {
    const beats = qualifying.slice(0, 3).map(m =>
      m.text.length > 800 ? m.text.substring(0, 800) + '...' : m.text
    );
    summaryExtended = beats.join('\n\n---\n\n');
  }

  return { summary, summaryExtended, bestScore };
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
