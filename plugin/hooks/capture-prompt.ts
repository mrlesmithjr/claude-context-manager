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

    process.stdout.write(JSON.stringify({ status: 'captured' }));
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Prompt capture error:', error);
    process.stdout.write(JSON.stringify({ status: 'error' }));
  } finally {
    storage.close();
  }
}

main();
