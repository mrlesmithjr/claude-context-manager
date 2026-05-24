/**
 * Query classification for retrieval routing.
 *
 * Classifies a search query to pick the optimal retrieval strategy:
 *   - keyword:  1-2 words, file names, identifiers (FTS5 fast path)
 *   - semantic: natural language starters or 5+ word queries (vector search)
 *   - hybrid:   3-4 words without an NL starter (FTS5 + vector, merged with RRF)
 */

export type QueryStrategy = 'keyword' | 'semantic' | 'hybrid';

const nlStarters = [
  'how', 'why', 'what', 'when', 'where', 'which',
  'explain', 'describe', 'show me', 'similar to',
];

/**
 * Classify a search query to pick the optimal retrieval strategy.
 */
export function classifyQuery(query: string): QueryStrategy {
  const words = query.trim().split(/\s+/);
  if (words.length <= 2) return 'keyword';
  if (nlStarters.some(s => query.toLowerCase().startsWith(s))) return 'semantic';
  if (words.length >= 5) return 'semantic';
  return 'hybrid';
}
