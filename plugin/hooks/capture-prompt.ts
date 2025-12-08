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
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');

  const logDir = path.join(os.homedir(), '.claude-context', 'logs');
  const logFile = path.join(logDir, 'prompt-hook-debug.log');

  function debugLog(msg: string) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch { /* ignore */ }
  }

  try {
    const inputStr = await readStdin();
    debugLog(`RAW_INPUT: ${inputStr.substring(0, 500)}`);

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
      debugLog(`PARSED_KEYS: ${Object.keys(rawInput).join(', ')}`);
    } catch (parseError) {
      debugLog(`PARSE_ERROR: ${parseError}`);
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
