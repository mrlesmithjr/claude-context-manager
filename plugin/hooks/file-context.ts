#!/usr/bin/env node
/**
 * File Context Hook (PreToolUse)
 *
 * Triggered before Read operations. If the file has been touched in prior
 * sessions, injects a compact history hint so Claude reads with relevant
 * context already loaded rather than recalling it from a broad SessionStart
 * summary.
 *
 * Four guards prevent noise:
 *   1. First read per file per session only (skip if already seen this session).
 *   2. Minimum of 2 prior observations from previous sessions required.
 *   3. Previous sessions only (current session excluded from results).
 *   4. Token cap: 3 observations max, single-line compact format (~80-100 tokens).
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "tool_name": "Read",
 *   "tool_input": { "file_path": "/absolute/path/to/file.ts" }
 * }
 *
 * Output (stdout JSON) when history exists:
 * {
 *   "hookSpecificOutput": {
 *     "hookEventName": "PreToolUse",
 *     "additionalContext": "[file history: file.ts - 3 prior sessions: ...]"
 *   }
 * }
 *
 * Output (stdout JSON) when no history or guards prevent injection:
 * {}
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { loadDotEnv } from '../../src/utils/env.js';
import { createDebugLogger } from '../../src/utils/logger.js';
import path from 'path';

const debugLog = createDebugLogger('file-context-hook-debug.log');

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
 * Format a date as "Mon DD" (e.g. "May 20"). No year needed for recent history.
 */
function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

async function main() {
  // Load .env before reading any process.env values so remote mode activates
  // even when Claude Code was launched from the Dock, Spotlight, or after a reboot.
  loadDotEnv();

  // Remote mode: no local SQLite access available. Return empty response immediately.
  const remoteUrl = (process.env['CONTEXT_MANAGER_URL'] ?? '').trim();
  if (remoteUrl) {
    debugLog('REMOTE_MODE_SKIP', { reason: 'file-context injection skipped in remote mode' });
    await writeResponse({});
    return;
  }

  let storage: SQLiteStorage | null = null;

  try {
    const inputStr = await readStdin();

    let rawInput: unknown;
    try {
      rawInput = JSON.parse(inputStr);
    } catch {
      debugLog('PARSE_ERROR', 'invalid JSON input');
      await writeResponse({});
      return;
    }

    // Parse required fields with bounds checking.
    const obj = (typeof rawInput === 'object' && rawInput !== null)
      ? rawInput as Record<string, unknown>
      : {};

    const sessionId = typeof obj.session_id === 'string' ? obj.session_id.slice(0, 256) : '';
    const cwd = typeof obj.cwd === 'string' ? obj.cwd.slice(0, 1024) : '';
    const toolName = typeof obj.tool_name === 'string' ? obj.tool_name : '';

    // Only handle Read operations (matcher in hooks.json also filters, but be explicit).
    if (toolName !== 'Read') {
      await writeResponse({});
      return;
    }

    // Extract file_path from tool_input.
    const toolInput = (typeof obj.tool_input === 'object' && obj.tool_input !== null)
      ? obj.tool_input as Record<string, unknown>
      : {};
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';

    if (!sessionId || !cwd || !filePath) {
      await writeResponse({});
      return;
    }

    debugLog('FILE_CONTEXT_REQUEST', { sessionId, cwd, filePath });

    storage = new SQLiteStorage();
    await storage.initialize();

    // Build LIKE pattern once; reused by both Guard 1 and getFileHistory.
    const escapedPath = filePath
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const likePattern = `%${escapedPath}%`;

    // Guard 1: first-read per file per session only.
    // Single indexed SQL query instead of loading all session observations.
    const alreadySeen = await storage.hasSessionSeenFile(sessionId, likePattern);
    if (alreadySeen) {
      debugLog('FILE_CONTEXT_SKIP_ALREADY_SEEN', { filePath, sessionId });
      await writeResponse({});
      return;
    }

    // Fetch prior observations from other sessions (limit to top 3 by recency).
    const history = await storage.getFileHistory(filePath, cwd, sessionId, 3);

    // Guard 2: minimum of 2 prior observations required.
    if (history.length < 2) {
      debugLog('FILE_CONTEXT_SKIP_INSUFFICIENT', { sessionId, filePath, count: history.length });
      await writeResponse({});
      return;
    }

    // Build compact history string.
    // Format: "[file history: file.ts - N prior sessions: summary1 (Mon DD), ...]"
    const fileName = path.basename(filePath);
    const entries = history.map(obs => {
      const dateLabel = formatDate(obs.created_at);
      // Keep summaries short. Truncate at 80 chars to stay within token budget.
      const raw = obs.summary.replace(/\n+/g, ' ').trim();
      const snippet = raw.length > 80 ? raw.substring(0, 80) + '...' : raw;
      return dateLabel ? `${snippet} (${dateLabel})` : snippet;
    });

    const count = history.length;
    const sessionWord = count === 1 ? 'session' : 'sessions';
    const context = `[file history: ${fileName} - ${count} prior ${sessionWord}: ${entries.join(', ')}]`;

    debugLog('FILE_CONTEXT_INJECT', { sessionId, filePath, count });

    await writeResponse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: context,
      },
    });
  } catch (error) {
    // Any error must return empty response. Never block a Read operation.
    debugLog('FILE_CONTEXT_ERROR', String(error));
    console.error('[context-manager] file-context hook error:', error);
    await writeResponse({});
  } finally {
    if (storage) await storage.close();
  }
}

main();
