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
import { remoteSaveObservation } from '../../src/capture/remote-client.js';
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

    // Check remote mode FIRST — before filesystem-based path validation.
    // In remote mode the project path is a server-side metadata label (not a local
    // filesystem path), so validateProjectPath() must be skipped. Lightweight bounds
    // checking is used instead.
    // Surprise scoring is also skipped in remote mode: encounter counts live in the
    // remote server's DB, not the local one.
    const remoteUrl = (process.env['CONTEXT_MANAGER_URL'] ?? '').trim();
    const remoteToken = (process.env['CONTEXT_MANAGER_TOKEN'] ?? '').trim();

    if (remoteUrl) {
      if (!remoteToken) {
        console.error(
          '[context-manager] CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is missing'
        );
        await writeResponse({ status: 'error', error: 'CONTEXT_MANAGER_TOKEN required when CONTEXT_MANAGER_URL is set' });
        return;
      }

      // Lightweight parse — bounds check only, no filesystem validation
      const obj = (typeof rawInput === 'object' && rawInput !== null)
        ? rawInput as Record<string, unknown>
        : {};

      const sessionId = typeof obj.session_id === 'string' ? obj.session_id.slice(0, 256) : '';
      const cwd = typeof obj.cwd === 'string' ? obj.cwd.slice(0, 1024) : '';
      const toolName = typeof obj.tool_name === 'string' ? obj.tool_name.slice(0, 128) : '';

      if (!sessionId || !cwd || !toolName) {
        await writeResponse({ status: 'skipped' });
        return;
      }

      if (!shouldCaptureTool(toolName, obj.tool_input)) {
        await writeResponse({ status: 'skipped' });
        return;
      }

      // Extract tool_response — same logic as the full validator
      let toolResponse: string | undefined;
      if (typeof obj.tool_response === 'string') {
        toolResponse = obj.tool_response;
      } else if (typeof obj.tool_response === 'object' && obj.tool_response !== null) {
        const resp = obj.tool_response as Record<string, unknown>;
        const stdout = typeof resp.stdout === 'string' ? resp.stdout : '';
        const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
        toolResponse = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      }

      const observation = processToolCapture({
        session_id: sessionId,
        project: cwd,
        tool_name: toolName,
        tool_input: obj.tool_input,
        tool_response: toolResponse,
      });

      try {
        await remoteSaveObservation({ url: remoteUrl, token: remoteToken }, observation);
        await writeResponse({ status: 'captured' });
      } catch (error) {
        console.error('[context-manager] Remote capture error:', error);
        await writeResponse({ status: 'error' });
      }
      return;
    }

    // --- Local mode: full validation with filesystem path checks, then write to SQLite ---
    const input = validatePostToolUseInput(rawInput);

    // Skip low-value tools (also checks command patterns for Bash)
    if (!shouldCaptureTool(input.tool_name, input.tool_input)) {
      await writeResponse({ status: 'skipped' });
      return;
    }

    // Process tool capture into observation (pure computation, no storage needed)
    const observation = processToolCapture({
      session_id: input.session_id,
      project: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: input.tool_response,
    });

    storage = new SQLiteStorage();
    await storage.initialize();

    // Surprise scoring: boost novel file encounters, decay frequent ones
    if (observation.files_touched.length > 0) {
      let surpriseAdj = 0;
      for (const file of observation.files_touched) {
        const count = await storage.incrementFileEncounter(file, input.cwd, input.tool_name);
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
    if (storage) await storage.close();
  }
}

main();
