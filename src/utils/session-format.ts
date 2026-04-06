/**
 * Shared session formatting helpers.
 * Used by both context_list (MCP) and auto-memory export.
 */

import type { Session, Observation, ImportanceLevel } from '../storage/interface.js';

/**
 * Compute human-readable session duration from timestamps.
 * Returns "45m", "1h 23m", "active", or "unknown".
 */
export function computeSessionDuration(session: Session): string {
  if (!session.ended_at) return 'active';

  const start = new Date(session.started_at).getTime();
  const end = new Date(session.ended_at).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return 'unknown';

  const minutes = Math.round((end - start) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

/**
 * Extract a clean narrative one-liner from a session summary.
 * Session summaries are often Claude's last response — conversational and verbose.
 * This extracts the first meaningful sentence/phrase.
 */
export function extractSessionNarrative(summary: string | undefined, maxLen: number = 120): string {
  if (!summary || summary.length < 10) return '';

  // Strip markdown formatting
  let text = summary.replace(/\*\*/g, '').replace(/`/g, '').trim();

  // Take first sentence
  const sentenceEnd = text.search(/[.!?\n]/);
  if (sentenceEnd > 0 && sentenceEnd < maxLen) {
    text = text.substring(0, sentenceEnd + 1);
  } else if (text.length > maxLen) {
    text = text.substring(0, maxLen).replace(/\s+\S*$/, '') + '...';
  }

  // Skip non-informative Claude responses but still return something
  if (text.match(/^(Let me|I'll|Here's the|Looking at|No response|Checking)/i)) {
    // Try to find a more meaningful part after the filler
    const afterFiller = summary.indexOf('\n');
    if (afterFiller > 0 && afterFiller < 200) {
      const next = summary.substring(afterFiller + 1).trim();
      if (next.length > 10) {
        return extractSessionNarrative(next, maxLen);
      }
    }
  }

  return text;
}

/**
 * Count observations by importance level.
 */
export function countByImportance(observations: Observation[]): { high: number; medium: number; low: number } {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const obs of observations) {
    const level = obs.importance as ImportanceLevel;
    if (level in counts) counts[level]++;
  }
  return counts;
}

/**
 * Format a short date from ISO string: "Mar 23" or "Apr 6".
 */
export function formatShortDate(isoDate: string): string {
  const date = new Date(isoDate);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}
