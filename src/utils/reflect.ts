/**
 * Reflection Engine
 *
 * Pure functions for deterministic pattern analysis of accumulated observations.
 * No I/O, no DB access, no LLM inference, purely frequency-based word counting.
 *
 * Used by the context_reflect MCP tool and the `reflect` CLI command to identify
 * recurring themes and propose CLAUDE.md additions.
 */

import type { Observation } from '../storage/interface.js';

export interface TagGroup {
  tag: string;
  observations: Observation[];
  sessionCount: number;   // distinct session_ids
  suggestedRule: string;  // derived from summary word frequency
}

export interface ReflectionResult {
  project: string;
  lookbackDays: number;
  totalObservations: number;
  tagGroups: TagGroup[];    // only groups with 3+ observations
  reflectionDate: string;   // ISO date (YYYY-MM-DD)
}

/**
 * Words to exclude from frequency analysis.
 * Common stop words plus domain-neutral technical terms that appear universally.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been',
  'were', 'will', 'when', 'what', 'which', 'into', 'then', 'than', 'also',
  'about', 'added', 'updated', 'changed', 'fixed', 'edit', 'read', 'file',
  'line', 'code', 'null', 'true', 'false', 'undefined',
]);

/**
 * Extract significant words from a text string.
 * Returns words that are 4+ characters and not in the stopwords list.
 */
function extractSignificantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * Find the top N most frequent words across a list of summary strings.
 */
function topFrequentWords(summaries: string[], topN: number): string[] {
  const freq = new Map<string, number>();

  for (const summary of summaries) {
    const words = extractSignificantWords(summary);
    const seen = new Set<string>();
    for (const word of words) {
      // Count each word once per summary to avoid bias from verbose summaries
      if (!seen.has(word)) {
        freq.set(word, (freq.get(word) ?? 0) + 1);
        seen.add(word);
      }
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([word]) => word);
}

/**
 * Derive a suggested CLAUDE.md rule from a tag group.
 *
 * Format: "Check <tag> context before changes: recurring themes include <term1>, <term2>, <term3>."
 * When the group contains any observation with lesson_type set, prefix with "Avoid: " instead.
 */
function deriveRule(tag: string, observations: Observation[]): string {
  const summaries = observations.map(o => o.summary);
  const terms = topFrequentWords(summaries, 5);

  const hasLesson = observations.some(o => o.lesson_type != null && o.lesson_type !== '');

  const termList = terms.length > 0 ? terms.join(', ') : tag;

  if (hasLesson) {
    return `Avoid: recurring ${tag} issues include ${termList}.`;
  }

  return `Check ${tag} context before changes: recurring themes include ${termList}.`;
}

/**
 * Build a reflection result from a list of observations.
 *
 * Groups observations by their first tag (or 'general' when no tags are present).
 * Keeps only groups with 3 or more observations.
 * Sorts by observation count descending.
 */
export function buildReflection(
  project: string,
  observations: Observation[],
  lookbackDays: number
): ReflectionResult {
  const reflectionDate = new Date().toISOString().substring(0, 10);

  // Group by first tag
  const groupMap = new Map<string, Observation[]>();

  for (const obs of observations) {
    const tag = obs.tags && obs.tags.length > 0 ? obs.tags[0]! : 'general';
    const existing = groupMap.get(tag);
    if (existing) {
      existing.push(obs);
    } else {
      groupMap.set(tag, [obs]);
    }
  }

  // Build TagGroup objects, keeping only groups with 3+ observations
  const tagGroups: TagGroup[] = [];

  for (const [tag, obs] of groupMap.entries()) {
    if (obs.length < 3) continue;

    const sessionIds = new Set(obs.map(o => o.session_id));

    tagGroups.push({
      tag,
      observations: obs,
      sessionCount: sessionIds.size,
      suggestedRule: deriveRule(tag, obs),
    });
  }

  // Sort by observation count descending
  tagGroups.sort((a, b) => b.observations.length - a.observations.length);

  return {
    project,
    lookbackDays,
    totalObservations: observations.length,
    tagGroups,
    reflectionDate,
  };
}

/**
 * Format a ReflectionResult as a human-readable report.
 * Output can be copied directly into CLAUDE.md.
 */
export function formatReflection(result: ReflectionResult): string {
  if (result.tagGroups.length === 0) {
    return (
      `No recurring patterns found in the last ${result.lookbackDays} days. ` +
      `Either too few observations or patterns are already well-addressed.`
    );
  }

  const lines: string[] = [];

  lines.push(`## Reflection: ${result.project} (last ${result.lookbackDays} days)`);
  lines.push('');
  lines.push(`${result.totalObservations} observations analyzed, ${result.reflectionDate}`);
  lines.push('');
  lines.push('### Recurring Patterns');
  lines.push('');

  for (const group of result.tagGroups) {
    const summaries = group.observations.map(o => o.summary);
    const terms = topFrequentWords(summaries, 5);
    const termList = terms.length > 0 ? terms.join(', ') : group.tag;

    lines.push(
      `**${group.tag}** (${group.observations.length} observations, ${group.sessionCount} session${group.sessionCount === 1 ? '' : 's'})`
    );
    lines.push(`- Recurring themes: ${termList}`);
    lines.push(`- Suggested CLAUDE.md addition: "${group.suggestedRule}"`);
    lines.push('');
  }

  lines.push('### Proposed Additions to CLAUDE.md');
  lines.push('');
  lines.push('Copy the following into CLAUDE.md as new rules:');
  lines.push('');

  for (const group of result.tagGroups) {
    lines.push(`- ${group.suggestedRule}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('Run context_reflect again after addressing these patterns to track improvement.');

  return lines.join('\n');
}
