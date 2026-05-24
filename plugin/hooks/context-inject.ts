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

// This will be injected by esbuild --define during build
declare const PLUGIN_VERSION: string;

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


async function main() {
  // Debug: log that hook was invoked
  console.error('[context-manager] SessionStart hook invoked');

  const storage = new SQLiteStorage();

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

    // Initialize storage
    await storage.initialize();

    // Create session record
    await storage.createSession(input.session_id, input.cwd);

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
    await storage.close();
  }
}

main();
