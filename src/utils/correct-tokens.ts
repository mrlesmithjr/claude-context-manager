/**
 * Fuzzy token correction for context_search queries.
 *
 * Splits a query into whitespace-separated tokens, attempts to correct
 * likely typos in plain tokens using a caller-supplied lookup function,
 * and returns the corrected query along with a list of applied changes.
 *
 * Operator-prefixed tokens (tag:, lesson:, decision:) are passed through
 * unchanged so that structured query syntax is never mangled.
 */

/** A single token substitution applied during correction. */
export interface Correction {
  from: string;
  to: string;
}

/** Result of a correction pass over a query string. */
export interface CorrectionResult {
  /** The query with typos replaced. Equals the input when no corrections were made. */
  corrected: string;
  /** List of substitutions that were applied (empty when no corrections were made). */
  changes: Correction[];
}

/**
 * Prefixes that indicate a structured operator token.
 * Tokens starting with any of these are never corrected.
 */
const OPERATOR_PREFIXES = ['tag:', 'lesson:', 'decision:'];

/**
 * Attempt to correct typos in a search query.
 *
 * Each whitespace-separated token is examined. If the token has no operator
 * prefix and the lookup function returns a non-null correction that differs
 * from the original, the substitution is recorded and applied.
 *
 * Whitespace between tokens is preserved so that the reconstructed query
 * matches the original spacing structure.
 *
 * @param query - The raw query string from the caller
 * @param findClosest - Function that maps a token to its closest known
 *   match, or returns null when no correction is available
 * @returns CorrectionResult with the corrected query and list of changes
 */
export function correctTokens(
  query: string,
  findClosest: (token: string) => string | null,
): CorrectionResult {
  // Split on whitespace while preserving the separators for reconstruction.
  // The pattern alternates between non-whitespace segments and whitespace segments.
  const parts = query.split(/(\s+)/);

  const changes: Correction[] = [];
  const correctedParts = parts.map(part => {
    // Whitespace segments pass through unchanged
    if (/^\s+$/.test(part) || part === '') {
      return part;
    }

    // Operator-prefixed tokens are structural; skip correction
    const lowerPart = part.toLowerCase();
    for (const prefix of OPERATOR_PREFIXES) {
      if (lowerPart.startsWith(prefix)) {
        return part;
      }
    }

    // Attempt correction via the supplied lookup
    const suggestion = findClosest(lowerPart);
    if (suggestion !== null && suggestion !== lowerPart) {
      changes.push({ from: lowerPart, to: suggestion });
      return suggestion;
    }

    return part;
  });

  return {
    corrected: correctedParts.join(''),
    changes,
  };
}
