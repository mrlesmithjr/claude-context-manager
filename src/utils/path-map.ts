/**
 * Path prefix normalization utility.
 *
 * Supports cross-device path mapping so that observations captured on one machine
 * (e.g., /root/Projects/...) can be read on another (e.g., /Users/larry/Projects/...).
 *
 * Configure via CONTEXT_MANAGER_PATH_MAP env var (JSON array):
 *   '[{"from":"/root","to":"/Users/larry/Projects"}]'
 */

export interface PathPrefixEntry {
  from: string;
  to: string;
}

/**
 * Load path prefix map from CONTEXT_MANAGER_PATH_MAP env var (JSON array).
 * Returns an empty array if the variable is unset or contains invalid JSON.
 *
 * Example env value:
 *   '[{"from":"/root/Projects","to":"/Users/larry/Projects"}]'
 */
export function loadPathPrefixMap(): PathPrefixEntry[] {
  const raw = process.env.CONTEXT_MANAGER_PATH_MAP || '';
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('[context-manager] CONTEXT_MANAGER_PATH_MAP must be a JSON array, ignoring');
      return [];
    }
    return parsed.filter((entry): entry is PathPrefixEntry => {
      const valid = entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).from === 'string' &&
        typeof (entry as Record<string, unknown>).to === 'string';
      if (!valid) {
        console.error(`[context-manager] Skipping invalid path map entry: ${JSON.stringify(entry)}`);
      }
      return valid;
    });
  } catch {
    console.error('[context-manager] Invalid CONTEXT_MANAGER_PATH_MAP JSON: path normalization disabled');
    return [];
  }
}

/**
 * Apply path prefix normalization: replace the first matching 'from' prefix with 'to'.
 * Returns the path unchanged if no mapping matches.
 *
 * Matching is prefix-based and case-sensitive.
 * The first matching entry wins. Order entries from most-specific to least-specific
 * when multiple prefixes could match the same path.
 */
export function normalizePath(p: string, map: PathPrefixEntry[]): string {
  for (const entry of map) {
    // Require an exact match or a path-separator boundary to prevent
    // /root matching /root2/project (which would corrupt the path).
    if (p === entry.from || p.startsWith(entry.from + '/')) {
      return entry.to + p.slice(entry.from.length);
    }
  }
  return p;
}
