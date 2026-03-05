#!/usr/bin/env node
/**
 * Context Injection Hook (SessionStart)
 *
 * Triggered when a new Claude Code session begins.
 * Fetches relevant context from SQLite and injects into session.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project"
 * }
 *
 * Output (stdout JSON):
 * {
 *   "context": "<claude-context>...</claude-context>"
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { validateSessionStartInput } from '../../src/utils/validation.js';
import { buildContext, buildVisibilityMessage, selectRelevantWithinBudget } from '../../src/inject/builder.js';
import { getPreviouslyContext } from '../../src/utils/transcript.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// This will be injected by esbuild --define during build
declare const PLUGIN_VERSION: string;

const TOKEN_BUDGET = parseInt(
  process.env.CONTEXT_MANAGER_TOKEN_BUDGET || '4000',
  10
);

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
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
      return `\n⚠️  **context-manager version mismatch detected**\n` +
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

    // Handle empty input gracefully (like claude-mem does)
    // Treat empty/whitespace input as empty object
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

    // Get recent files as "working set" for relevance scoring
    const recentObs = await storage.getRecent(input.cwd, 50);
    const workingFileSet = new Set<string>();
    for (const obs of recentObs) {
      for (const f of obs.files_touched) {
        workingFileSet.add(f);
      }
    }

    // Get candidate observations and select by relevance
    const candidates = await storage.getRelevantCandidates(input.cwd, 200);
    const observations = selectRelevantWithinBudget(candidates, TOKEN_BUDGET, workingFileSet);

    // Get recent session summary (optional)
    const sessions = await storage.getRecentSessions(input.cwd, 1);
    const lastSummary = sessions[0]?.summary;

    // Get "Previously" context from prior session transcript
    const previouslyContext = await getPreviouslyContext(
      input.cwd,
      input.session_id,
      async (project, limit) => storage.getRecentSessions(project, limit)
    );

    // Check for version mismatch
    const versionWarning = checkVersionMismatch();

    // Build context for injection (pass cwd for project grouping)
    let context = buildContext(observations, input.cwd, lastSummary, previouslyContext);

    // Prepend version warning if present
    if (versionWarning) {
      context = versionWarning + '\n' + context;
    }

    // Build visibility message (pass cwd for project grouping)
    const visibilityMessage = buildVisibilityMessage(observations, input.cwd);

    // Log visibility message to stderr (visible to user)
    if (observations.length > 0) {
      console.error(visibilityMessage);
    }

    // Return context using hookSpecificOutput format (compatible with thinking mode)
    // This is the same format used by claude-mem
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context
      }
    }));
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Error:', error);
    // Return empty hookSpecificOutput response on error
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ''
      }
    }));
  } finally {
    storage.close();
  }
}

main();
