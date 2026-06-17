import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Recognized environment variables loaded from ~/.claude-context/.env:
 *
 * CONTEXT_MANAGER_DB                  - SQLite database path (default: ~/.claude-context/context.db)
 * CONTEXT_MANAGER_TOKEN_BUDGET        - Max tokens per MCP recall tool response (default: 4000)
 * CONTEXT_MANAGER_PORT                - Web dashboard port (default: 3847)
 * CONTEXT_MANAGER_URL                 - Remote capture server URL (enables proxy mode)
 * CONTEXT_MANAGER_TOKEN               - Bearer token for remote mode (required when URL is set)
 * CONTEXT_MANAGER_CHECKPOINT_INTERVAL - Minutes between checkpoint exports (default: 30)
 * CONTEXT_MANAGER_EMBED_INTERVAL      - Minutes between background embedding passes (default: 10)
 * CONTEXT_MANAGER_CAPTURE_FLOOR       - Min importance score for capture, clamped [0.0, 0.65] (default: 0.15)
 * CONTEXT_MANAGER_DECAY_HALFLIFE      - Decay half-life in days for applyDecay(), clamped [1, 3650] (default: 60)
 * CONTEXT_MANAGER_PRIORITY_RESERVE   - Fraction of effective budget reserved for Conversation/pinned/Manual
 *                                       observations in getWithinBudget() Pass 0; clamped [0.0, 0.5] (default: 0.25).
 *                                       Set to 0.0 to disable the priority reserve entirely.
 * CONTEXT_SEARCH_MIN_SCORE            - Min cosine similarity for semantic/hybrid results (default: 0.25)
 * CONTEXT_MANAGER_BRANCH_AWARE        - Enable git branch capture and soft-rank boost (default: off).
 *                                       Truthy values: 1, true, yes (case-insensitive). Any other value = off.
 *                                       When off, all getCurrentBranch() calls are bypassed and
 *                                       branch is stored as null. The branch columns and soft-rank
 *                                       logic remain in place; only the capture/boost path is skipped.
 *                                       fixes #149
 */

/**
 * Returns true when git branch awareness is enabled via CONTEXT_MANAGER_BRANCH_AWARE.
 * Default is OFF. Truthy values: "1", "true", "yes" (case-insensitive).
 * Call this after loadDotEnv() so the env var is populated from ~/.claude-context/.env.
 * fixes #149
 */
export function isBranchAware(): boolean {
  const val = (process.env['CONTEXT_MANAGER_BRANCH_AWARE'] ?? '').trim().toLowerCase();
  return val === '1' || val === 'true' || val === 'yes';
}

/**
 * Load environment variables from ~/.claude-context/.env into process.env.
 *
 * Called at startup by the MCP server and all hooks so that
 * CONTEXT_MANAGER_URL and CONTEXT_MANAGER_TOKEN are available regardless
 * of how Claude Code was launched (terminal, Dock, Spotlight, reboot).
 *
 * Existing process.env values always win -- explicit env vars are never overridden.
 */
export function loadDotEnv(): void {
  const envPath = join(homedir(), '.claude-context', '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip matching surrounding quotes added by manual edits (e.g. VAR="value")
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[context-manager] Warning: could not read ~/.claude-context/.env:', (err instanceof Error ? err.message : String(err)));
    }
    // ENOENT: .env file is optional, silently skip
  }
}
