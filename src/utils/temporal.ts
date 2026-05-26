/**
 * Temporal intent classification for context_search routing.
 *
 * Detects whether a query is asking for current state, historical information,
 * or is neutral, so result ranking can be adjusted accordingly.
 *
 * Classification is case-insensitive. Signal words are matched as whole phrases
 * using word-boundary-aware matching to avoid false positives.
 *
 * If both current and historical signals appear in the same query, the result
 * is neutral (conflicting signals cancel out).
 */

export type TemporalMode = 'current' | 'historical' | 'neutral';

const CURRENT_SIGNALS: readonly string[] = [
  'now',
  'current',
  'currently',
  'latest',
  'today',
  'recent',
  'recently',
  'right now',
  'at the moment',
  'as of',
  'nowadays',
  'present',
  'presently',
  'existing',
  'active',
];

const HISTORICAL_SIGNALS: readonly string[] = [
  'history',
  'historical',
  'when did',
  'previously',
  'before',
  'used to',
  'changed',
  'over time',
  'timeline',
  'in the past',
  'last week',
  'last month',
  'last year',
  'ago',
  'originally',
  'prior',
  'earlier',
  'past',
  'evolution',
  'progression',
];

/**
 * Returns true if the lowercased query contains the signal phrase as a whole word
 * or whole phrase (surrounded by word boundaries or string edges).
 */
function containsSignal(lowerQuery: string, signal: string): boolean {
  // For multi-word signals, check as a substring within word boundaries.
  // For single-word signals, require non-alphanumeric characters on both sides.
  const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');
  return pattern.test(lowerQuery);
}

/**
 * Classify the temporal intent of a search query.
 *
 * Returns:
 *   'current'    - query asks about current/recent state (boost recent results)
 *   'historical' - query asks about the past (sort chronologically ascending)
 *   'neutral'    - no temporal signal, or conflicting signals (default behavior)
 */
export function classifyTemporalIntent(query: string): TemporalMode {
  const lower = query.toLowerCase();

  const hasCurrent = CURRENT_SIGNALS.some(s => containsSignal(lower, s));
  const hasHistorical = HISTORICAL_SIGNALS.some(s => containsSignal(lower, s));

  if (hasCurrent && hasHistorical) return 'neutral';
  if (hasCurrent) return 'current';
  if (hasHistorical) return 'historical';
  return 'neutral';
}
