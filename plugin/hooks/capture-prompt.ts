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
import { remoteSavePrompt } from '../../src/capture/remote-client.js';
import { loadDotEnv } from '../../src/utils/env.js';

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
  // Load .env before reading any process.env values so remote mode activates
  // even when Claude Code was launched from the Dock, Spotlight, or after a reboot.
  loadDotEnv();

  // Storage is only opened in local mode; remote mode has no local SQLite footprint.
  let storage: SQLiteStorage | null = null;
  const debugLog = createDebugLogger('prompt-hook-debug.log');

  try {
    const inputStr = await readStdin();

    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      debugLog('PARSE_ERROR', String(parseError));
      console.error('[context-manager] Invalid JSON input');
      await writeResponse({ status: 'error' });
      return;
    }

    // Check remote mode FIRST — before filesystem-based path validation.
    // In remote mode the project path is a server-side metadata label (not a local
    // filesystem path), so validateProjectPath() must be skipped. Lightweight bounds
    // checking is used instead.
    const remoteUrl = (process.env['CONTEXT_MANAGER_URL'] ?? '').trim();
    const remoteToken = (process.env['CONTEXT_MANAGER_TOKEN'] ?? '').trim();

    if (remoteUrl) {
      if (!remoteToken) {
        console.error(
          '[context-manager] CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is missing'
        );
        await writeResponse({ status: 'error' });
        return;
      }

      // Lightweight parse — bounds check only, no filesystem validation
      const obj = (typeof rawInput === 'object' && rawInput !== null)
        ? rawInput as Record<string, unknown>
        : {};

      const sessionId = typeof obj.session_id === 'string' ? obj.session_id.slice(0, 256) : '';
      const cwd = typeof obj.cwd === 'string' ? obj.cwd.slice(0, 1024) : '';
      const rawPrompt = typeof obj.prompt === 'string' ? obj.prompt : '';
      const promptNumber = typeof obj.prompt_number === 'number' ? obj.prompt_number : 0;

      if (!sessionId || !cwd || !rawPrompt) {
        await writeResponse({ status: 'error' });
        return;
      }

      const sanitizedPrompt = sanitizeContent(rawPrompt);
      debugLog('PROMPT_CAPTURED', {
        sessionId,
        promptLength: sanitizedPrompt.length,
        project: cwd,
      });

      const remotePayload = {
        session_id: sessionId,
        project: cwd,
        prompt_number: promptNumber,
        prompt_text: sanitizedPrompt,
        created_at: new Date().toISOString(),
      };

      try {
        await remoteSavePrompt({ url: remoteUrl, token: remoteToken }, remotePayload);
        await writeResponse({ status: 'captured' });
      } catch (error) {
        console.error('[context-manager] Remote prompt capture error:', error);
        await writeResponse({ status: 'error' });
      }
      return;
    }

    // --- Local mode: full validation with filesystem path checks, then write to SQLite ---
    const input = validateUserPromptSubmitInput(rawInput);

    // Sanitize prompt text (strip <private> tags and sensitive data)
    const sanitizedPrompt = sanitizeContent(input.prompt);

    // Log metadata only — never log prompt content even in debug mode
    debugLog('PROMPT_CAPTURED', {
      sessionId: input.session_id,
      promptLength: sanitizedPrompt.length,
      project: input.cwd,
    });

    const promptPayload = {
      session_id: input.session_id,
      project: input.cwd,
      prompt_number: input.prompt_number,
      prompt_text: sanitizedPrompt,
      created_at: new Date().toISOString(),
    };

    storage = new SQLiteStorage();
    await storage.initialize();
    await storage.saveUserPrompt(promptPayload);

    await writeResponse({ status: 'captured' });
  } catch (error) {
    // Fail silently - never block Claude Code
    console.error('[context-manager] Prompt capture error:', error);
    await writeResponse({ status: 'error' });
  } finally {
    if (storage) await storage.close();
  }
}

main();
