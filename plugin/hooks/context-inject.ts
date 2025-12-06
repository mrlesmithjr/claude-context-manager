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
import { buildContext, buildVisibilityMessage } from '../../src/inject/builder.js';
import { getPreviouslyContext } from '../../src/utils/transcript.js';

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

    // Get observations within token budget
    const observations = await storage.getWithinBudget(input.cwd, TOKEN_BUDGET);

    // Get recent session summary (optional)
    const sessions = await storage.getRecentSessions(input.cwd, 1);
    const lastSummary = sessions[0]?.summary;

    // Get "Previously" context from prior session transcript
    const previouslyContext = await getPreviouslyContext(
      input.cwd,
      input.session_id,
      async (project, limit) => storage.getRecentSessions(project, limit)
    );

    // Build context for injection (pass cwd for project grouping)
    const context = buildContext(observations, input.cwd, lastSummary, previouslyContext);

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
