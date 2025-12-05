#!/usr/bin/env node
/**
 * Capture Tool Hook (PostToolUse)
 *
 * Triggered after every tool execution.
 * Stores tool interaction in SQLite.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "tool_name": "Read",
 *   "tool_input": { "file_path": "/path/to/file.ts" },
 *   "tool_response": "file contents..."
 * }
 *
 * Output (stdout JSON):
 * {
 *   "status": "captured" | "skipped" | "error"
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import {
  validatePostToolUseInput,
  shouldCaptureTool,
} from '../../src/utils/validation.js';
import { processToolCapture } from '../../src/capture/processor.js';

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
      process.stdout.write(JSON.stringify({ status: 'error', error: 'Invalid JSON input' }));
      return;
    }

    // Validate and sanitize input
    const input = validatePostToolUseInput(rawInput);

    // Skip low-value tools
    if (!shouldCaptureTool(input.tool_name)) {
      process.stdout.write(JSON.stringify({ status: 'skipped' }));
      return;
    }

    // Initialize storage
    await storage.initialize();

    // Process tool capture into observation
    const observation = processToolCapture({
      session_id: input.session_id,
      project: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: input.tool_response,
    });

    // Save observation
    await storage.save(observation);

    process.stdout.write(JSON.stringify({ status: 'captured' }));
  } catch (error) {
    // Don't block Claude Code on errors
    console.error('[context-manager] Capture error:', error);
    process.stdout.write(JSON.stringify({ status: 'error' }));
  } finally {
    storage.close();
  }
}

main();
