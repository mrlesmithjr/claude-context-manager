#!/usr/bin/env node
/**
 * Context Injection Hook (SessionStart)
 *
 * Triggered when a new Claude Code session begins.
 * Creates session record and injects a minimal status hint.
 * High-value context is now exported to auto-memory topic files
 * at session end (Stop hook), not injected here.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project"
 * }
 *
 * Output (stdout JSON):
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "SessionStart",
 *     "additionalContext": "..."
 *   }
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { validateSessionStartInput } from '../../src/utils/validation.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  remoteCreateSession,
  remoteGetMemory,
  remoteHealthCheck,
  remoteMcpText,
} from '../../src/capture/remote-client.js';
import { loadDotEnv } from '../../src/utils/env.js';

// Injected by esbuild --define during build
declare const PLUGIN_VERSION: string;
// Injected by esbuild banner. True when plugin/node_modules/ native binaries are present.
declare const __nativeModulesAvailable: boolean;

// Duplicated in capture-tool.ts, capture-prompt.ts, and session-end.ts.
// Plugin hooks are compiled independently by esbuild into single-file bundles;
// there is no shared hook module to import from, so each file carries its own copy.
const NO_NATIVE_ERROR =
  '[context-manager] No server configured and native SQLite modules are not available.\n' +
  "Run 'make server-quickstart' (macOS) or 'make server-start' (Docker) to set up a server,\n" +
  'then restart Claude Code.\n' +
  "For local SQLite mode: clone the repo, run 'npm install', and install locally with\n" +
  "'/plugin marketplace add /path/to/repo'.";

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

/** Write JSON to stdout and wait for it to flush before continuing. */
function writeResponse(data: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(JSON.stringify(data) + '\n');
    if (ok) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
      process.stdout.once('error', reject);
    }
  });
}

/**
 * Check for version mismatch between source and installed plugin
 * Returns a warning message if versions differ, empty string otherwise
 */
function checkVersionMismatch(): string {
  try {
    const installedPluginPath = join(
      homedir(),
      '.claude',
      'plugins',
      'context-manager',
      'package.json'
    );

    // If plugin not installed yet, skip check
    if (!existsSync(installedPluginPath)) {
      return '';
    }

    // Read installed version
    const installedPackageJson = JSON.parse(
      readFileSync(installedPluginPath, 'utf-8')
    );
    const installedVersion = installedPackageJson.version;

    // Compare versions
    if (installedVersion !== PLUGIN_VERSION) {
      return `\n[WARNING] **context-manager version mismatch detected**\n` +
             `   Installed: v${installedVersion}\n` +
             `   Source:    v${PLUGIN_VERSION}\n` +
             `   Run: \`npm run build:plugin && /plugin install context-manager\`\n`;
    }

    return '';
  } catch (error) {
    // Fail silently - version check is not critical
    console.error('[context-manager] Version check failed:', error);
    return '';
  }
}


// Maximum characters of server memory content to inject into additionalContext.
// Keeps the session start hint within a reasonable token budget (~750 tokens).
const REMOTE_MEMORY_INJECT_MAX = 3000;

async function main() {
  // Load .env before reading any process.env values so remote mode activates
  // even when Claude Code was launched from the Dock, Spotlight, or after a reboot.
  loadDotEnv();

  // Debug: log that hook was invoked
  console.error('[context-manager] SessionStart hook invoked');

  // Storage is only opened in local mode; remote mode has no local SQLite footprint.
  let storage: SQLiteStorage | null = null;

  try {
    const inputStr = await readStdin();

    // Handle empty input gracefully
    let rawInput;
    try {
      rawInput = inputStr.trim() ? JSON.parse(inputStr) : {};
    } catch (parseError) {
      console.error('[context-manager] Invalid JSON input, using defaults');
      rawInput = {};
    }

    // Validate and sanitize input
    const input = validateSessionStartInput(rawInput);

    // --- Remote mode: create session + fetch context from central server ---
    const remoteUrl = (process.env['CONTEXT_MANAGER_URL'] ?? '').trim();
    const remoteToken = (process.env['CONTEXT_MANAGER_TOKEN'] ?? '').trim();

    if (remoteUrl) {
      if (!remoteToken) {
        console.error(
          '[context-manager] CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is missing'
        );
        await writeResponse({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: '[context-manager] Remote mode misconfigured: CONTEXT_MANAGER_TOKEN is required.',
          },
        });
        return;
      }

      const client = { url: remoteUrl, token: remoteToken };

      // Health check: if the server is configured but not reachable, inject a clear
      // warning so Claude surfaces it to the user immediately. Skip session creation
      // and all further remote calls — they would all fail anyway.
      const serverReachable = await remoteHealthCheck(client);
      if (!serverReachable) {
        console.error(`[context-manager] Remote server unreachable at ${remoteUrl}`);
        await writeResponse({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: [
              `[WARNING] context-manager server not responding at ${remoteUrl}.`,
              `Observations are not being captured this session.`,
              `Run 'make server-status' to diagnose, then restart Claude Code.`,
            ].join('\n'),
          },
        });
        return;
      }

      // Create session on the remote server (best-effort, non-blocking on failure)
      try {
        await remoteCreateSession(client, input.session_id, input.cwd);
      } catch (err) {
        console.error('[context-manager] Remote session create failed:', err);
      }

      // Build remote status hint
      const versionWarning = checkVersionMismatch();
      const lines: string[] = [];
      if (versionWarning) lines.push(versionWarning);

      // Get observation count from remote via context_stats.
      // remoteMcpText never throws; it returns '' on any error.
      let remoteCount = 0;
      const statsText = await remoteMcpText(client, 'context_stats', { project: input.cwd });
      const countMatch = statsText.match(/Total Observations:\s*(\d+)/);
      if (countMatch?.[1]) remoteCount = parseInt(countMatch[1], 10);

      lines.push(`context-manager v${PLUGIN_VERSION} active (remote mode). ${remoteCount} observations on server.`);
      lines.push(`Remote server: ${remoteUrl}`);
      lines.push('MCP tools available: context_search, context_list, context_stats.');

      // Fetch memory content exported by the previous session's Stop hook.
      // remoteGetMemory never throws; it returns '' on any error.
      const memoryContent = await remoteGetMemory(client, input.cwd);
      if (memoryContent.trim().length > 0) {
        lines.push('');
        lines.push('Recent activity (from server memory):');
        const capped = memoryContent.length > REMOTE_MEMORY_INJECT_MAX
          ? memoryContent.substring(0, REMOTE_MEMORY_INJECT_MAX) + '\n... (truncated)'
          : memoryContent;
        lines.push(capped);
      }

      const context = lines.join('\n');
      console.error(`[context-manager] Remote mode: ${remoteCount} observations on server`);

      await writeResponse({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      });
      return;
    }

    // --- Local mode: direct SQLite access ---
    if (!__nativeModulesAvailable) {
      console.error(NO_NATIVE_ERROR);
      await writeResponse({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: NO_NATIVE_ERROR,
        },
      });
      return;
    }

    storage = new SQLiteStorage();
    await storage.initialize();

    // Create session record
    await storage.createSession(input.session_id, input.cwd);

    // Close any stale active sessions from previous runs that never fired Stop.
    // Silent — no logging, no effect on the hook response.
    try {
      await storage.closeStaleActiveSessions();
    } catch {
      // Never let GC failure affect session start
    }

    // Get observation count for status hint
    const count = await storage.countObservations(input.cwd);

    // Check for version mismatch
    const versionWarning = checkVersionMismatch();

    // Build status hint
    const lines: string[] = [];
    if (versionWarning) {
      lines.push(versionWarning);
    }
    lines.push(`context-manager v${PLUGIN_VERSION} active. ${count} observations tracked.`);
    lines.push('Activity log exported to auto-memory. MCP tools available: context_search, context_list, context_stats.');

    // Inject recent session summaries for project continuity
    try {
      const recentSessions = await storage.getRecentSessionsWithObservations(input.cwd, 10);
      const withSummaries = recentSessions
        .map(r => r.session)
        .filter(s => s.summary && s.summary.trim().length > 20 && s.status === 'complete');

      // Diversify by parent project path — one session per unique parent directory
      const seen = new Set<string>();
      const diverse = withSummaries.filter(s => {
        const parts = s.project.split('/');
        const parentKey = parts.slice(0, -1).join('/') || s.project;
        if (seen.has(parentKey)) return false;
        seen.add(parentKey);
        return true;
      });

      if (diverse.length > 0) {
        const sessionLines = diverse.slice(0, 5).map(s => {
          const date = new Date(s.started_at);
          const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const raw = s.summary!.replace(/\n+/g, ' ');
          const snippet = raw.length > 250 ? raw.substring(0, 250) + '...' : raw;
          return `- [${label}] ${snippet}`;
        });
        lines.push('');
        lines.push('Recent sessions:');
        lines.push(...sessionLines);
      }
    } catch {
      // Non-critical — skip if session lookup fails
    }

    const context = lines.join('\n');

    // Log status to stderr (visible to user)
    console.error(`[context-manager] ${count} observations tracked, activity exported to auto-memory`);

    // Return context using hookSpecificOutput format (compatible with thinking mode)
    await writeResponse({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context
      }
    });
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Error:', error);
    await writeResponse({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ''
      }
    });
  } finally {
    if (storage) await storage.close();
  }
}

main();
