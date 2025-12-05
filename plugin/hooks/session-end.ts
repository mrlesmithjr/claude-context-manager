#!/usr/bin/env node
/**
 * Session End Hook (Stop)
 *
 * Triggered when Claude Code session ends.
 * Stores session summary in SQLite.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "transcript_summary": "What was accomplished..."
 * }
 *
 * Output (stdout JSON):
 * {
 *   "status": "complete" | "error"
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { validateStopInput } from '../../src/utils/validation.js';

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const storage = new SQLiteStorage();

  try {
    const inputStr = await readStdin();

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      console.error('[context-manager] Invalid JSON input');
      process.stdout.write(JSON.stringify({ status: 'error' }));
      return;
    }

    // Validate and sanitize input
    const input = validateStopInput(rawInput);

    // Initialize storage
    await storage.initialize();

    // End session with summary
    await storage.endSession(input.session_id, input.transcript_summary);

    process.stdout.write(JSON.stringify({ status: 'complete' }));
  } catch (error) {
    console.error('[context-manager] Session end error:', error);
    process.stdout.write(JSON.stringify({ status: 'error' }));
  } finally {
    storage.close();
  }
}

main();
