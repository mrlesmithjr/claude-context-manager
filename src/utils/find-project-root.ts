/**
 * Find the nearest project root by walking up from cwd looking for marker files.
 *
 * Used at write time to normalize subdirectory launches to the nearest known
 * root (e.g., launching from an Obsidian DailyNotes subfolder normalizes to
 * the vault root that contains .obsidian/).
 *
 * The existing hierarchical LIKE query (WHERE project LIKE path%) already
 * ensures parent-sees-children at read time, so normalization only needs to
 * happen at write time.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

/**
 * Default root markers. A directory containing any of these is treated as a
 * project root. Listed roughly in order of specificity so the first match is
 * the most meaningful boundary.
 */
const DEFAULT_ROOT_MARKERS = [
  '.git',
  '.obsidian',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  '.claude',
];

/**
 * Return the list of markers to check, merging defaults with any extras
 * provided via CONTEXT_MANAGER_ROOT_MARKERS (comma-separated).
 */
function getMarkers(): string[] {
  const extra = process.env['CONTEXT_MANAGER_ROOT_MARKERS'];
  if (!extra) return DEFAULT_ROOT_MARKERS;
  const extras = extra.split(',').map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_ROOT_MARKERS, ...extras];
}

/**
 * Walk up from `cwd` until reaching `homedir()` or the filesystem root,
 * returning the first (deepest) directory that contains a project root marker.
 *
 * Returns `cwd` unchanged if no marker is found — safe no-op for cross-machine
 * remote mode where the path is a metadata label, not a real filesystem path.
 *
 * @param cwd - Absolute path to start walking from
 * @returns Normalized project root path
 */
export function findProjectRoot(cwd: string): string {
  const markers = getMarkers();
  const home = homedir();
  let current = cwd;

  while (current !== home && current !== dirname(current)) {
    for (const marker of markers) {
      if (existsSync(join(current, marker))) {
        return current;
      }
    }
    current = dirname(current);
  }

  // Check home directory itself (handles vault roots directly in ~)
  for (const marker of markers) {
    if (existsSync(join(home, marker))) {
      return home;
    }
  }

  return cwd;
}
