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
import { SLASH_COMMANDS } from '../../src/commands/definitions.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
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

/**
 * Auto-provision slash commands to ~/.claude/commands/ if missing.
 * Runs on every SessionStart but only writes files that don't exist,
 * so it's a no-op after first run (~1ms check).
 */
function provisionSlashCommands(): number {
  try {
    const commandsDir = join(homedir(), '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    let installed = 0;
    for (const [filename, content] of Object.entries(SLASH_COMMANDS)) {
      const dest = join(commandsDir, filename);
      if (!existsSync(dest)) {
        writeFileSync(dest, content);
        installed++;
      }
    }
    return installed;
  } catch {
    return 0;
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

    // Auto-provision slash commands on first run
    const commandsInstalled = provisionSlashCommands();
    if (commandsInstalled > 0) {
      console.error(`[context-manager] Auto-installed ${commandsInstalled} slash commands`);
    }

    // Create session record
    await storage.createSession(input.session_id, input.cwd);

    // Get observation count for status hint
    const count = await storage.countObservations(input.cwd);

    // Check for version mismatch
    const versionWarning = checkVersionMismatch();

    // Build minimal status hint (~30 tokens instead of ~1,400)
    const lines: string[] = [];
    if (versionWarning) {
      lines.push(versionWarning);
    }
    lines.push(`context-manager v${PLUGIN_VERSION} active. ${count} observations tracked.`);
    lines.push('Activity log exported to auto-memory. Use /ctx-search <query> for full history.');

    const context = lines.join('\n');

    // Log status to stderr (visible to user)
    console.error(`[context-manager] ${count} observations tracked, activity exported to auto-memory`);

    // Return context using hookSpecificOutput format (compatible with thinking mode)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context
      }
    }));
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Error:', error);
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
