/**
 * Git utilities
 *
 * Pure utility functions for interacting with git.
 * No imports from project internals.
 */

import { spawnSync } from 'child_process';

/**
 * Get the current git branch name for a given working directory.
 *
 * Returns null when:
 * - The path is not a git repository
 * - git is not available
 * - The repo is in detached HEAD state
 * - The command times out
 * - Any error occurs
 *
 * Never throws. All errors produce null.
 */
export function getCurrentBranch(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (result.status !== 0 || result.error) return null;
    const branch = result.stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}
