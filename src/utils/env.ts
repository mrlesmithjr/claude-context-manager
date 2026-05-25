import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
