/**
 * Version bump detection utility.
 * Shared between processor.ts and memory.ts.
 */

/**
 * Returns true if the file path belongs to a version-managed manifest.
 *
 * Detection is file-path-based, not content-based. This is intentional:
 * Sprint 1 fix #15 strips old_string/new_string from stored metadata, so
 * content-based detection is unavailable at export time. At capture time
 * (processor.ts), file-path detection is simpler and covers the common case.
 *
 * Trade-off: non-version edits to package.json or pyproject.toml (e.g.
 * adding a dependency) will also score lower and be suppressed from export.
 * This is an acceptable false-positive rate given how infrequently these
 * files are edited for reasons other than version management.
 */
export function isVersionBump(filePath: string): boolean {
  return /package\.json|pyproject\.toml|version\.ts/.test(filePath);
}
