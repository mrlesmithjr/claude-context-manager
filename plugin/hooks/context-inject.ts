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
  remoteCloseStale,
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
// This message is returned as additionalContext at SessionStart so Claude sees it and can
// guide the user through setup interactively. It is intentionally self-contained — new users
// installing from the marketplace will not have any external skill files available.
const NO_NATIVE_ERROR =
  '[context-manager] No server configured. Observations are not being captured this session.\n' +
  '\n' +
  'To set up the server, Claude can run these steps with you:\n' +
  '\n' +
  'macOS (recommended):\n' +
  '  git clone git@github.com:mrlesmithjr/claude-context-manager.git ~/claude-context-manager\n' +
  '  cd ~/claude-context-manager && npm install\n' +
  '  make server-quickstart          # creates token, installs launchd service, starts server\n' +
  '  /plugin update context-manager  # run inside Claude Code, then restart Claude Code\n' +
  '\n' +
  'Linux / Docker:\n' +
  '  git clone git@github.com:mrlesmithjr/claude-context-manager.git ~/claude-context-manager\n' +
  '  cd ~/claude-context-manager && npm install\n' +
  '  make server-init   # creates ~/.claude-context/.env with a token\n' +
  '  make server-start  # starts Docker containers\n' +
  '  /plugin update context-manager  # run inside Claude Code, then restart Claude Code\n' +
  '\n' +
  'Say "help me set up context-manager" and Claude will walk through each step.';

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
              ``,
              `If the server stopped:`,
              `  cd ~/claude-context-manager && make server-restart`,
              `  Then restart Claude Code.`,
              ``,
              `If this is a new machine and the server has never been set up, say`,
              `"help me set up context-manager" and Claude will walk through the full setup.`,
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

      // Close stale active sessions on the server — mirrors the local-mode GC call
      // that runs in the SQLite path below. Sessions that were 'active' for more
      // than 2 hours without a Stop hook (crashed runs, E2E leftovers) are marked
      // 'complete'. Best-effort: never blocks the hook response.
      try {
        await remoteCloseStale(client);
      } catch {
        // Silently ignore — GC failure must never affect session start
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
      lines.push('MCP tools available: context_search, context_list, context_stats, context_lessons.');

      // Recent failures hint via remote context_lessons call (last 7 days only)
      try {
        const lessonsText = await remoteMcpText(client, 'context_lessons', {
          project: input.cwd,
          limit: 3,
          days: 7,
        });
        if (lessonsText && lessonsText.trim().length > 0 && !lessonsText.startsWith('No lessons')) {
          // Parse lesson blocks: each block starts with [date time] lesson_type | tool_name
          const blocks = lessonsText.split('\n\n').filter(b => b.trim().length > 0);
          if (blocks.length > 0) {
            const items = blocks.slice(0, 3).map(block => {
              const firstLine = block.split('\n')[0] ?? '';
              // Extract date like [2026-05-25 14:32]
              const dateMatch = firstLine.match(/\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\]/);
              const dateLabel = dateMatch?.[1]
                ? new Date(dateMatch[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : '';
              // Extract lesson type | tool
              const typeMatch = firstLine.match(/\] (.+?) \| /);
              const summaryLine = block.split('\n')[1] ?? '';
              const fragment = summaryLine.length > 40 ? summaryLine.substring(0, 40) : summaryLine;
              const typeLabel = typeMatch?.[1] ?? 'error';
              return dateLabel ? `${fragment} (${typeLabel}, ${dateLabel})` : `${fragment} (${typeLabel})`;
            });
            lines.push(`Recent failures (${items.length}): ${items.join(' · ')}`);
          }
        }
      } catch {
        // Non-critical — skip if lessons call fails in remote mode
      }

      // Recent decisions hint via remote context_decisions call
      try {
        const decisionsText = await remoteMcpText(client, 'context_decisions', {
          project: input.cwd,
          limit: 3,
        });
        if (decisionsText && decisionsText.trim().length > 0 && !decisionsText.startsWith('No decisions')) {
          // Each decision block starts with "#N [Month Day, Year] text"
          const blocks = decisionsText.split('\n\n').filter(b => b.trim().length > 0);
          if (blocks.length > 0) {
            const items = blocks.slice(0, 3).map(block => {
              const firstLine = block.split('\n')[0] ?? '';
              // Extract #N
              const numMatch = firstLine.match(/^(#\d+)/);
              // Extract [Month Day, Year]
              const dateMatch = firstLine.match(/\[([^\]]+)\]/);
              const dateLabel = dateMatch?.[1] ?? '';
              // Extract decision text after the date bracket
              const afterDate = dateMatch
                ? firstLine.slice(firstLine.indexOf(']') + 1).trim()
                : firstLine;
              const fragment = afterDate.length > 40 ? afterDate.substring(0, 40) : afterDate;
              const numLabel = numMatch?.[1] ?? '';
              return numLabel
                ? `${numLabel} ${fragment} (${dateLabel})`
                : `${fragment} (${dateLabel})`;
            });
            lines.push(`Recent decisions: ${items.join(' · ')}`);
          }
        }
      } catch {
        // Non-critical — skip if decisions call fails in remote mode
      }

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
    lines.push('Activity log exported to auto-memory. MCP tools available: context_search, context_list, context_stats, context_lessons.');

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

    // Recent failures hint: query the last 7 days of lessons for this project
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentLessons = await storage.getLessons(input.cwd, undefined, undefined, 3, sevenDaysAgo);
      if (recentLessons.length > 0) {
        const items = recentLessons.slice(0, 3).map(l => {
          const date = new Date(l.created_at);
          const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const fragment = l.summary.length > 40 ? l.summary.substring(0, 40) : l.summary;
          return `${fragment} (${dateLabel})`;
        });
        lines.push(`Recent failures (${recentLessons.length}): ${items.join(' · ')}`);
      }
    } catch {
      // Non-critical — skip if lessons query fails
    }

    // Recent decisions hint: query the last 3 decisions for this project
    try {
      const recentDecisions = await storage.searchDecisions(input.cwd, undefined, 3);
      if (recentDecisions.length > 0) {
        const items = recentDecisions.map(d => {
          const date = new Date(d.captured_at);
          const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const numLabel = d.decision_number != null ? `#${d.decision_number}` : '';
          const fragment = d.decision_text.length > 40
            ? d.decision_text.substring(0, 40)
            : d.decision_text;
          return numLabel
            ? `${numLabel} ${fragment} (${dateLabel})`
            : `${fragment} (${dateLabel})`;
        });
        lines.push(`Recent decisions: ${items.join(' · ')}`);
      }
    } catch {
      // Non-critical — skip if decisions query fails
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
