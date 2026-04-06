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

async function main() {
  const storage = new SQLiteStorage();

  try {
    const inputStr = await readStdin();

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      console.error('[context-manager] Invalid JSON input');
      await writeResponse({ status: 'error', error: 'Invalid JSON input' });
      return;
    }

    // Validate and sanitize input
    const input = validatePostToolUseInput(rawInput);

    // Skip low-value tools (now also checks command patterns for Bash)
    if (!shouldCaptureTool(input.tool_name, input.tool_input)) {
      await writeResponse({ status: 'skipped' });
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

    // Surprise scoring: boost novel file encounters, decay frequent ones
    if (observation.files_touched.length > 0) {
      let surpriseAdj = 0;
      for (const file of observation.files_touched) {
        const count = storage.incrementFileEncounter(file, input.cwd, input.tool_name);
        if (count === 1) surpriseAdj += 0.15;
        else if (count <= 3) surpriseAdj += 0.05;
        else if (count > 10) surpriseAdj -= 0.10;
      }
      surpriseAdj = Math.max(-0.15, Math.min(0.20, surpriseAdj));
      if (surpriseAdj !== 0) {
        const adjusted = Math.max(0, Math.min(1, observation.importance_score + surpriseAdj));
        observation.importance_score = Math.round(adjusted * 100) / 100;
        observation.importance = adjusted >= 0.65 ? 'high' : adjusted >= 0.35 ? 'medium' : 'low';
      }
    }

    // Save observation (also infers relationships)
    await storage.save(observation);

    await writeResponse({ status: 'captured' });
  } catch (error) {
    // Don't block Claude Code on errors
    console.error('[context-manager] Capture error:', error);
    await writeResponse({ status: 'error' });
  } finally {
    storage.close();
  }
}

main();
