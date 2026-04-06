#!/usr/bin/env node
/**
 * Capture Prompt Hook (UserPromptSubmit)
 *
 * Triggered when user submits a prompt.
 * Stores prompt text in SQLite with FTS5 for searchability.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "prompt_number": 1,
 *   "prompt": "Implement feature X"
 * }
 *
 * Output (stdout JSON):
 * {
 *   "status": "captured" | "error"
 * }
 */

import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { validateUserPromptSubmitInput } from '../../src/utils/validation.js';
import { sanitizeContent } from '../../src/utils/sanitize.js';
import { createDebugLogger } from '../../src/utils/logger.js';

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
  const debugLog = createDebugLogger('prompt-hook-debug.log');

  try {
    const inputStr = await readStdin();
    debugLog('RAW_INPUT', inputStr.substring(0, 500));

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
      debugLog('PARSED_KEYS', Object.keys(rawInput).join(', '));
    } catch (parseError) {
      debugLog('PARSE_ERROR', String(parseError));
      console.error('[context-manager] Invalid JSON input');
      await writeResponse({ status: 'error' });
      return;
    }

    // Validate and sanitize input
    const input = validateUserPromptSubmitInput(rawInput);

    // Initialize storage
    await storage.initialize();

    // Sanitize prompt text (strip <private> tags and sensitive data)
    const sanitizedPrompt = sanitizeContent(input.prompt);

    // Save user prompt
    await storage.saveUserPrompt({
      session_id: input.session_id,
      project: input.cwd,
      prompt_number: input.prompt_number,
      prompt_text: sanitizedPrompt,
      created_at: new Date().toISOString(),
    });

    await writeResponse({ status: 'captured' });
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Prompt capture error:', error);
    await writeResponse({ status: 'error' });
  } finally {
    storage.close();
  }
}

main();
