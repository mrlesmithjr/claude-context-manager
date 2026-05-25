#!/usr/bin/env node
/**
 * Capture Prompt Hook (UserPromptSubmit)
 *
 * Triggered when user submits a prompt.
 * Stores prompt text in SQLite with FTS5 for searchability.
 *
 * Also runs a periodic checkpoint when the elapsed time since the last
 * checkpoint (or session start) exceeds CONTEXT_MANAGER_CHECKPOINT_INTERVAL
 * minutes (default: 30). The checkpoint writes a draft session summary and
 * exports high-importance observations to auto-memory so the file is never
 * more than N minutes stale, even if the session never ends cleanly.
 *
 * Input (stdin JSON):
 * {
 *   "session_id": "abc123",
 *   "cwd": "/path/to/project",
 *   "prompt_number": 1,
 *   "prompt": "Implement feature X",
 *   "transcript_path": "/path/to/transcript.jsonl"
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
import { remoteSavePrompt, remoteExportMemory } from '../../src/capture/remote-client.js';
import { loadDotEnv } from '../../src/utils/env.js';
import { exportToAutoMemory } from '../../src/export/memory.js';
import { pickBestNarrative } from '../../src/utils/transcript.js';
import * as fs from 'fs';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const debugLog = createDebugLogger('prompt-hook-debug.log');

/** Default checkpoint interval in minutes. */
const DEFAULT_CHECKPOINT_INTERVAL_MINUTES = 30;

/** Wall-clock budget for the checkpoint in milliseconds (3 seconds). */
const CHECKPOINT_WALL_CLOCK_BUDGET_MS = 3000;

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

/**
 * Read and resolve the checkpoint interval from the environment.
 * Returns the interval in milliseconds.
 */
function readCheckpointIntervalMs(): number {
  const raw = process.env['CONTEXT_MANAGER_CHECKPOINT_INTERVAL'];
  if (raw !== undefined) {
    const minutes = parseInt(raw, 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return minutes * 60 * 1000;
    }
  }
  return DEFAULT_CHECKPOINT_INTERVAL_MINUTES * 60 * 1000;
}

/**
 * Safely resolve a transcript path to ensure it stays within the expected
 * Claude projects directory. Returns null if the path is absent, malformed,
 * or resolves outside the allowed boundary.
 */
function safeResolveTranscriptPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const expectedRoot = path.resolve(homedir(), '.claude', 'projects');
  try {
    const resolved = realpathSync(raw);
    if (resolved.startsWith(expectedRoot + path.sep)) return resolved;
    return null;
  } catch (err: unknown) {
    // File may not exist yet at checkpoint time. Fall back to lexical check.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const lexical = path.resolve(raw);
      return lexical.startsWith(expectedRoot + path.sep) ? lexical : null;
    }
    return null;
  }
}

/**
 * Run a periodic checkpoint for the current session.
 *
 * Steps:
 *   1. Pick the best-scoring assistant message from the transcript as a draft summary.
 *   2. Write the draft summary to sessions.summary (Stop hook overwrites with final).
 *   3. Export high-importance observations to the auto-memory topic file.
 *   4. Update last_checkpoint_at on the session.
 *
 * Insight extraction (conversation tables, recommendations) is intentionally
 * skipped here. That scoring pass is expensive and is better left to Stop.
 *
 * The caller is responsible for the wall-clock guard: call this inside a
 * Promise.race with a timeout and abort if the budget is exceeded.
 */
async function runCheckpoint(
  storage: SQLiteStorage,
  sessionId: string,
  project: string,
  transcriptPath: string | null
): Promise<void> {
  // Skip if the session has no observations yet. Nothing useful to export.
  const sessionObs = await storage.getSessionObservations(sessionId);
  if (sessionObs.length === 0) {
    debugLog('CHECKPOINT_SKIP_NO_OBS', { sessionId });
    return;
  }

  // Pick a draft narrative from the current transcript (best assistant message so far).
  let draftSummary: string | undefined;
  let narrativeBestScore = 0;
  if (transcriptPath) {
    try {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.trim().length > 0);
      const result = pickBestNarrative(lines);
      draftSummary = result.summary;
      narrativeBestScore = result.bestScore;
    } catch {
      // Transcript read failure is non-fatal; proceed without a draft summary.
      debugLog('CHECKPOINT_TRANSCRIPT_ERROR', { transcriptPath });
    }
  }

  // Conversation fallback: when narrative scoring yields a weak result (score < 0.20),
  // check for a Conversation observation to use as the draft summary. This handles
  // discussion and planning sessions that produce no code-change signals.
  if (narrativeBestScore < 0.20) {
    try {
      const topConversation = await storage.getTopConversationObservation(sessionId);
      if (topConversation?.summary) {
        draftSummary = topConversation.summary;
        debugLog('CHECKPOINT_SUMMARY_CONVERSATION_FALLBACK', { sessionId, summary: draftSummary.substring(0, 100) });
      }
    } catch (fallbackError) {
      debugLog('CHECKPOINT_FALLBACK_ERROR', { error: String(fallbackError) });
    }
  }

  // Write the draft summary without changing the session status or ended_at.
  // The Stop hook will overwrite sessions.summary with the final version on clean exit.
  // Using updateSessionDraftSummary rather than endSession preserves the 'active'
  // status so the session continues to behave correctly in injection queries and
  // the web dashboard.
  if (draftSummary) {
    await storage.updateSessionDraftSummary(sessionId, draftSummary);
    debugLog('CHECKPOINT_DRAFT_SUMMARY', { sessionId, length: draftSummary.length });
  }

  // Export high-importance observations to the auto-memory topic file.
  try {
    const result = await exportToAutoMemory(storage, project, sessionId);
    if (result.exported > 0) {
      debugLog('CHECKPOINT_EXPORTED', { sessionId, exported: result.exported });
      console.error(
        `[context-manager] Checkpoint: exported ${result.exported} observations to auto-memory`
      );
    }
  } catch (exportError) {
    console.error('[context-manager] Checkpoint export failed:', exportError);
  }

  // Record that the checkpoint ran successfully.
  await storage.updateSessionCheckpoint(sessionId, Date.now());
  debugLog('CHECKPOINT_COMPLETE', { sessionId });
}

/**
 * Determine whether a checkpoint is due for the given session.
 * Returns true when:
 *   - The session exists and has observations.
 *   - The elapsed time since last_checkpoint_at (or started_at) >= the interval.
 */
async function isCheckpointDue(
  storage: SQLiteStorage,
  sessionId: string,
  intervalMs: number
): Promise<boolean> {
  const timestamps = await storage.getSessionTimestamps(sessionId);
  if (!timestamps) return false;

  const now = Date.now();
  const baseline =
    timestamps.last_checkpoint_at !== null
      ? timestamps.last_checkpoint_at
      : new Date(timestamps.started_at).getTime();

  return now - baseline >= intervalMs;
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
      debugLog('PARSE_ERROR', String(parseError));
      console.error('[context-manager] Invalid JSON input');
      await writeResponse({ status: 'error' });
      return;
    }

    // Check remote mode FIRST: before filesystem-based path validation.
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

      // Lightweight parse: bounds check only, no filesystem validation
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
      } catch (error) {
        console.error('[context-manager] Remote prompt capture error:', error);
        await writeResponse({ status: 'error' });
        return;
      }

      // Remote checkpoint: POST to the server's export endpoint.
      // In remote mode there is no local DB to query for last_checkpoint_at, so
      // we attempt an export on every prompt and rely on the server-side
      // exported_at guard (in getUnexportedHighImportance) to skip observations
      // that were already exported. The wall-clock guard caps total latency.
      try {
        const checkpointTimer = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, CHECKPOINT_WALL_CLOCK_BUDGET_MS);
          if (typeof t === 'object' && t !== null && 'unref' in t) (t as ReturnType<typeof setTimeout>).unref();
        });

        await Promise.race([
          (async () => {
            const exportedContent = await remoteExportMemory(
              { url: remoteUrl, token: remoteToken },
              cwd,
              sessionId
            );
            if (exportedContent.trim().length > 0) {
              debugLog('CHECKPOINT_REMOTE_EXPORTED', { sessionId });
              console.error('[context-manager] Checkpoint: remote memory export triggered');
            }
          })(),
          checkpointTimer,
        ]);
      } catch {
        // Checkpoint failure is non-fatal. Never block Claude Code.
      }

      await writeResponse({ status: 'captured' });
      return;
    }

    // --- Local mode: full validation with filesystem path checks, then write to SQLite ---
    const input = validateUserPromptSubmitInput(rawInput);

    // Sanitize prompt text (strip <private> tags and sensitive data)
    const sanitizedPrompt = sanitizeContent(input.prompt);

    // Log metadata only. Never log prompt content even in debug mode
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

    // --- Periodic checkpoint ---
    // Check whether a checkpoint is due before acknowledging the prompt.
    // The wall-clock guard (CHECKPOINT_WALL_CLOCK_BUDGET_MS) ensures the hook
    // never exceeds its 5s timeout even if export or DB operations are slow.
    try {
      const intervalMs = readCheckpointIntervalMs();
      const checkpointDue = await isCheckpointDue(storage, input.session_id, intervalMs);

      if (checkpointDue) {
        debugLog('CHECKPOINT_DUE', { sessionId: input.session_id });

        // Safely resolve the transcript path from the raw input object.
        const rawObj = rawInput as Record<string, unknown>;
        const transcriptPath = safeResolveTranscriptPath(rawObj['transcript_path']);

        // Race the checkpoint against the wall-clock budget.
        const wallClockGuard = new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            debugLog('CHECKPOINT_TIMEOUT', { sessionId: input.session_id });
            console.error('[context-manager] Checkpoint: wall-clock budget exceeded, aborting');
            resolve();
          }, CHECKPOINT_WALL_CLOCK_BUDGET_MS);
          if (typeof t === 'object' && t !== null && 'unref' in t) (t as ReturnType<typeof setTimeout>).unref();
        });

        await Promise.race([
          runCheckpoint(storage, input.session_id, input.cwd, transcriptPath),
          wallClockGuard,
        ]);
      }
    } catch (checkpointError) {
      // Checkpoint failure is non-fatal. Never block Claude Code.
      debugLog('CHECKPOINT_ERROR', { error: String(checkpointError) });
      console.error('[context-manager] Checkpoint error:', checkpointError);
    }

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
