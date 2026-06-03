/**
 * HTTP MCP server mode.
 *
 * Starts a Fastify server with:
 * - StreamableHTTP MCP transport at /mcp
 * - Bearer token auth (CONTEXT_MANAGER_TOKEN required)
 * - Rate limiting and CORS controls consistent with the web dashboard
 *
 * Usage:
 *   CONTEXT_MANAGER_TOKEN=<secret> node dist/cli.js serve --port 4666
 */

import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyCors from '@fastify/cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createContextManagerServer } from '../mcp/create-server.js';
import { SQLiteStorage } from '../storage/sqlite.js';
import { loadPathPrefixMap, normalizePath } from '../utils/path-map.js';
import { findProjectRoot } from '../utils/find-project-root.js';
import { sanitizeContent } from '../utils/sanitize.js';
import { exportToAutoMemory, resolveMemoryDir } from '../export/memory.js';
import { getEmbeddingService } from '../embedding/service.js';
import { buildSessionEmbeddingText } from '../embedding/enrichment.js';

// Read version at startup. Three sources in priority order:
//   1. PLUGIN_VERSION -- injected as a string literal by esbuild define in build-hooks.js;
//      present in plugin bundles (plugin/scripts/mcp-http/index.cjs) where no filesystem read is safe
//   2. package.json -- works in the dist/ dev path (dist/server/http.js -> ../../package.json)
//   3. npm_package_version -- only set when launched via `npm`; launchd does not set it
declare const PLUGIN_VERSION: string | undefined;
const __serverDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION: string = (() => {
  if (typeof PLUGIN_VERSION !== 'undefined' && PLUGIN_VERSION) return PLUGIN_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(join(__serverDir, '../../package.json'), 'utf-8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    throw new Error('version missing');
  } catch {
    return process.env['npm_package_version'] ?? 'unknown';
  }
})();

// --- Background Compaction ---

/**
 * Compact old observations in the background after the HTTP server starts.
 * Runs until the abort signal fires. After each pass, waits
 * CONTEXT_MANAGER_COMPACT_INTERVAL hours before running again. Uses the same
 * 7-day threshold as the vacuum() / context_vacuum MCP tool. Silently skips
 * passes when nothing is eligible.
 */
async function backgroundCompact(storage: SQLiteStorage, signal: AbortSignal): Promise<void> {
  // Short delay — compaction is non-urgent; 10s gives server startup and embed initialization a clean head start.
  try {
    await abortableSleep(10000, signal);
  } catch {
    return; // Aborted before we even started — exit cleanly
  }

  const rawInterval = parseInt(process.env.CONTEXT_MANAGER_COMPACT_INTERVAL || '24', 10);
  const intervalHours = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 24;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  console.error(`[context-manager-http] Background compaction loop: interval ${intervalHours}h`);

  while (!signal.aborted) {
    try {
      const result = await storage.compactObservations(7);
      if (result.compacted > 0 || result.originals > 0) {
        console.error(
          `[context-manager-http] Background compaction complete: ${result.compacted} groups, ${result.originals} originals removed`
        );
      }
    } catch (err) {
      if (signal.aborted) break;
      console.error('[context-manager-http] Background compaction error:', err);
    }

    // Wait before next pass (abortable)
    try {
      await abortableSleep(intervalMs, signal);
    } catch {
      break; // Aborted during inter-pass sleep
    }
  }
}

// --- Background Embedding ---

/**
 * Sleep for `ms` milliseconds, but resolve immediately if `signal` is aborted.
 * Throws an AbortError if the signal fires so callers can catch and exit.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Embed observations and sessions in the background after the HTTP server starts.
 * Runs until the abort signal fires. After each pass completes, waits
 * CONTEXT_MANAGER_EMBED_INTERVAL minutes before checking again. Silently skips
 * passes when nothing is pending. Silently skips if dependencies aren't installed
 * yet (first context_embed call will trigger auto-install).
 */
async function backgroundEmbed(storage: SQLiteStorage, signal: AbortSignal): Promise<void> {
  // Short delay to let the server finish startup. Abortable so shutdown is instant.
  try {
    await abortableSleep(5000, signal);
  } catch {
    return; // Aborted before we even started — exit cleanly
  }

  const rawInterval = parseInt(process.env.CONTEXT_MANAGER_EMBED_INTERVAL || '10', 10);
  const intervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 10;
  const intervalMs = intervalMinutes * 60 * 1000;
  console.error(`[context-manager-http] Background embedding loop: interval ${intervalMinutes}m`);

  while (!signal.aborted) {
    try {
      if (!await storage.isVectorSearchEnabled()) {
        await abortableSleep(intervalMs, signal);
        continue;
      }

      // Check if there's anything to embed
      const pending = storage.countUnembedded();
      const pendingSessions = await storage.countUnembeddedSessions();

      if (pending === 0 && pendingSessions === 0) {
        // Nothing to do — sleep and retry next interval
        await abortableSleep(intervalMs, signal);
        continue;
      }

      const embeddingService = getEmbeddingService();

      // Only proceed if transformers is already installed.
      // Don't auto-install in background. That's a first-run experience
      // that should happen via explicit context_embed call.
      const { status } = embeddingService.getStatus();
      if (status === 'unavailable') {
        console.error('[context-manager-http] Background embedding: transformers unavailable, skipping. Run context_embed to trigger install.');
        await abortableSleep(intervalMs, signal);
        continue;
      }

      const loaded = await embeddingService.load();
      if (!loaded) {
        await abortableSleep(intervalMs, signal);
        continue;
      }

      if (pending > 0) {
        console.error(`[context-manager-http] Background embedding: ${pending} observations pending`);
      }

      const BATCH_SIZE = 50;
      const BATCH_DELAY_MS = 500; // pause between batches to stay gentle
      let totalEmbedded = 0;

      while (!signal.aborted) {
        const batch = await storage.getUnembeddedObservations(BATCH_SIZE);
        if (batch.length === 0) break;

        const texts = batch.map(obs => {
          const parts = [obs.summary];
          if (obs.files_touched.length > 0) {
            parts.push(obs.files_touched.join(', '));
          }
          return parts.join(' | ');
        });

        // ONNX inference cannot be interrupted mid-flight; run it, then check signal
        const embeddings = await embeddingService.embedBatch(texts);
        if (!embeddings) break;

        // Check signal before writing results from the completed inference
        if (signal.aborted) break;

        for (let j = 0; j < batch.length; j++) {
          const obs = batch[j];
          const emb = embeddings[j];
          if (!obs?.id || !emb) continue;
          try {
            await storage.saveEmbedding(obs.id, emb);
            totalEmbedded++;
          } catch {
            // skip individual failures
          }
        }

        // Pause between batches (abortable)
        try {
          await abortableSleep(BATCH_DELAY_MS, signal);
        } catch {
          break; // Aborted during inter-batch pause
        }
      }

      if (totalEmbedded > 0) {
        console.error(`[context-manager-http] Background embedding complete: ${totalEmbedded} observations embedded`);
      }

      // --- Session embeddings ---
      if (pendingSessions > 0 && !signal.aborted) {
        console.error(`[context-manager-http] Background session embedding: ${pendingSessions} sessions pending`);

        let totalSessionEmbedded = 0;

        while (!signal.aborted) {
          const sessionBatch = await storage.getUnembeddedSessions(50);
          if (sessionBatch.length === 0) break;

          for (const session of sessionBatch) {
            if (signal.aborted) break;
            try {
              // Use pre-built enriched_text for manual sessions (written by addManualObservation);
              // fall back to buildSessionEmbeddingText for hook sessions.
              let enrichedText: string;
              if (session.enriched_text) {
                enrichedText = session.enriched_text;
              } else {
                const [prompts, observations] = await Promise.all([
                  storage.getSessionPrompts(session.id),
                  storage.getSessionObservations(session.id),
                ]);
                enrichedText = buildSessionEmbeddingText(prompts, observations, session.summary);
              }
              if (enrichedText.length < 20) continue;

              // ONNX inference cannot be interrupted; run it, then check signal
              const sessionEmb = await embeddingService.embed(enrichedText);
              if (signal.aborted) break;

              if (sessionEmb) {
                await storage.saveSessionEmbedding(session.id, sessionEmb, enrichedText);
                totalSessionEmbedded++;
              }
            } catch {
              // skip individual failures
            }

            // Brief pause between sessions (abortable)
            try {
              await abortableSleep(100, signal);
            } catch {
              break; // Aborted during per-session pause
            }
          }

          // Pause between batches to stay gentle on resources (abortable)
          try {
            await abortableSleep(BATCH_DELAY_MS, signal);
          } catch {
            break; // Aborted during inter-batch pause
          }
        }

        if (totalSessionEmbedded > 0) {
          console.error(`[context-manager-http] Background session embedding complete: ${totalSessionEmbedded} sessions embedded`);
        }
      }
    } catch (err) {
      // If we were aborted, exit the loop cleanly rather than logging as an error
      if (signal.aborted) break;
      console.error('[context-manager-http] Background embedding error:', err);
    }

    // Wait before next pass (success, empty, or error) — abortable
    try {
      await abortableSleep(intervalMs, signal);
    } catch {
      break; // Aborted during inter-pass sleep
    }
  }
}

export interface HttpServerOptions {
  port?: number;
  host?: string;
  token?: string;
  dbPath?: string;
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<void> {
  const port = options.port ?? parseInt(process.env.CONTEXT_MANAGER_PORT || '4666', 10);
  const host = options.host ?? (process.env.CONTEXT_MANAGER_HOST || '0.0.0.0');
  const token = options.token ?? (process.env.CONTEXT_MANAGER_TOKEN || '');
  const dbPath = options.dbPath ?? (
    process.env.CONTEXT_MANAGER_DB || join(homedir(), '.claude-context', 'context.db')
  );

  // Token is mandatory in HTTP server mode. There is no loopback-only exemption
  // because the whole point of this mode is to expose the server over the network.
  if (!token) {
    console.error('[context-manager-http] CONTEXT_MANAGER_TOKEN is required for HTTP server mode');
    console.error('  Generate one: openssl rand -hex 32');
    process.exit(1);
  }

  // Load path prefix map for cross-device path normalization
  const pathMap = loadPathPrefixMap();
  if (pathMap.length > 0) {
    console.error(`[context-manager-http] Path prefix map loaded: ${pathMap.length} entries`);
  }

  // Initialize storage
  const storage = new SQLiteStorage(dbPath);
  await storage.initialize();

  // Create Fastify
  const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  // Rate limiting
  await fastify.register(fastifyRateLimit, {
    max: parseInt(process.env.CONTEXT_MANAGER_RATE_LIMIT || '120', 10),
    timeWindow: '1 minute',
    skipOnError: false,
  });

  // CORS: restrict to explicit origins; empty list means no cross-origin access
  const corsOrigins = (process.env.CONTEXT_MANAGER_CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  await fastify.register(fastifyCors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'DELETE'],
  });

  // Bearer token auth on all routes (constant-time comparison to resist timing attacks)
  fastify.addHook('onRequest', async (request, reply) => {
    // Health check is exempt from auth so monitoring can probe without a token
    if (request.url === '/health') return;

    const authHeader = request.headers['authorization'] || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const expectedBuf = Buffer.from(token);

    // Allocate a buffer of the same length as expected and copy provided into it.
    // This ensures timingSafeEqual always compares equal-length buffers.
    const actualBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(provided).copy(actualBuf, 0, 0, expectedBuf.length);

    const lengthMatch = provided.length === token.length;
    const contentMatch = timingSafeEqual(expectedBuf, actualBuf);

    if (!lengthMatch || !contentMatch) {
      await reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
    }
  });

  // Health check (no auth required)
  fastify.get('/health', async (_request, reply) => {
    await reply.send({ status: 'ok', mode: 'http-mcp', version: SERVER_VERSION });
  });

  // --- Write endpoints: hooks in proxy mode POST here when CONTEXT_MANAGER_URL is set ---
  //
  // These are the server-side counterparts of the remote-client.ts helpers.
  // All endpoints are protected by the same Bearer auth as the /mcp route.
  // Payload size bounds prevent over-large writes from exhausting storage.

  const SESSION_ID_MAX = 256;
  const PROJECT_MAX = 1024;
  const SUMMARY_MAX = 8000;
  const SUMMARY_EXT_MAX = 16000;
  const OBS_SUMMARY_MAX = 4000;
  const FILES_MAX = 100;
  const FILE_PATH_MAX = 512;
  const PROMPT_TEXT_MAX = 20000;
  const VALID_LESSON_TYPES = new Set(['error', 'build_failure', 'test_failure', 'permission_denied']);

  /** Assert a field is a non-empty string within the given length limit. */
  function strBound(val: unknown, max: number, field: string): string {
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`${field} is required and must be a non-empty string`);
    }
    if (val.length > max) {
      throw new Error(`${field} exceeds maximum length ${max}`);
    }
    return val;
  }

  // POST /capture/session — create or end a session
  fastify.post('/capture/session', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const action = body['action'];

      if (action === 'create') {
        const sessionId = strBound(body['session_id'], SESSION_ID_MAX, 'session_id');
        const project = strBound(body['project'], PROJECT_MAX, 'project');
        const branch =
          typeof body['branch'] === 'string' && body['branch'].length > 0
            ? body['branch'].substring(0, 256)
            : null;
        const normalizedProject = findProjectRoot(normalizePath(project, pathMap));
        await storage.createSession(sessionId, normalizedProject, branch);
        await reply.send({ status: 'ok' });
      } else if (action === 'end') {
        const sessionId = strBound(body['session_id'], SESSION_ID_MAX, 'session_id');
        const summary = typeof body['summary'] === 'string'
          ? body['summary'].substring(0, SUMMARY_MAX)
          : undefined;
        const summaryExtended = typeof body['summary_extended'] === 'string'
          ? body['summary_extended'].substring(0, SUMMARY_EXT_MAX)
          : undefined;
        await storage.endSession(sessionId, summary, summaryExtended);
        await reply.send({ status: 'ok' });
      } else {
        await reply.status(400).send({ error: 'action must be "create" or "end"' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(400).send({ error: msg });
    }
  });

  // POST /capture/session/gc — close stale active sessions (no Stop hook within 2h)
  // Called by context-inject in remote mode at SessionStart, mirroring the local
  // closeStaleActiveSessions() call that runs in the local SQLite path.
  fastify.post('/capture/session/gc', async (_request, reply) => {
    try {
      const closed = await storage.closeStaleActiveSessions();
      await reply.send({ status: 'ok', closed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(500).send({ error: msg });
    }
  });

  // POST /capture/observation — save one observation from a remote hook
  fastify.post('/capture/observation', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;

      const sessionId = strBound(body['session_id'], SESSION_ID_MAX, 'session_id');
      const project = strBound(body['project'], PROJECT_MAX, 'project');
      const toolName = strBound(body['tool_name'], 64, 'tool_name');
      const summary = strBound(body['summary'], OBS_SUMMARY_MAX, 'summary');

      const importance = body['importance'] as string;
      if (!['high', 'medium', 'low'].includes(importance)) {
        await reply.status(400).send({ error: 'importance must be "high", "medium", or "low"' });
        return;
      }

      const importanceScore = typeof body['importance_score'] === 'number'
        ? Math.max(0, Math.min(1, body['importance_score']))
        : 0.5;

      const tokenEstimate = typeof body['token_estimate'] === 'number'
        ? Math.max(1, Math.min(50000, body['token_estimate']))
        : 50;

      const rawFiles = Array.isArray(body['files_touched']) ? body['files_touched'] : [];
      const filesTouched = rawFiles
        .slice(0, FILES_MAX)
        .filter((f): f is string => typeof f === 'string')
        .map((f) => f.substring(0, FILE_PATH_MAX));

      const metadata =
        typeof body['metadata'] === 'object' && body['metadata'] !== null
          ? (body['metadata'] as Record<string, unknown>)
          : {};

      const rawTags = Array.isArray(body['tags']) ? body['tags'] : undefined;
      const tags = rawTags
        ? rawTags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.substring(0, 32))
        : undefined;

      const contentHash =
        typeof body['content_hash'] === 'string'
          ? body['content_hash'].substring(0, 64)
          : undefined;

      const lessonType =
        body['lesson_type'] === null || body['lesson_type'] === undefined
          ? null
          : typeof body['lesson_type'] === 'string' && VALID_LESSON_TYPES.has(body['lesson_type'])
            ? body['lesson_type']
            : null;

      const skill =
        typeof body['skill'] === 'string' && body['skill'].length > 0
          ? body['skill'].substring(0, 256)
          : null;

      const branch =
        typeof body['branch'] === 'string' && body['branch'].length > 0
          ? body['branch'].substring(0, 256)
          : null;

      const pkg =
        typeof body['package'] === 'string' && body['package'].length > 0
          ? body['package'].substring(0, 256)
          : undefined;

      // Validate ISO 8601 timestamp before accepting — arbitrary strings would corrupt date sorting
      const rawCreatedAt = body['created_at'];
      const createdAt =
        typeof rawCreatedAt === 'string' && !isNaN(Date.parse(rawCreatedAt))
          ? rawCreatedAt
          : new Date().toISOString();

      const normalizedProject = findProjectRoot(normalizePath(project, pathMap));

      const observationPayload = {
        session_id: sessionId,
        project: normalizedProject,
        tool_name: toolName,
        summary,
        files_touched: filesTouched,
        metadata,
        token_estimate: tokenEstimate,
        importance: importance as 'high' | 'medium' | 'low',
        importance_score: importanceScore,
        tags,
        content_hash: contentHash,
        created_at: createdAt,
        lesson_type: lessonType,
        skill,
        branch,
        package: pkg,
      };

      try {
        await storage.save(observationPayload);
      } catch (saveErr) {
        // Two scenarios produce an FK violation here:
        // 1. Sub-agent sessions (Agent tool): the sub-agent spawns its own session_id
        //    but its SessionStart hook never fires (matcher 'startup|clear|compact'
        //    doesn't match sub-agent initialization), so no session row exists.
        // 2. Regular sessions where remoteCreateSession() failed at startup (network
        //    error, server restart during hook) — the session_id is valid but the
        //    row was never written.
        // In both cases: create a minimal session row and retry the save once.
        // refs #236
        if (saveErr instanceof Error && saveErr.message.includes('FOREIGN KEY')) {
          await storage.createSession(sessionId, normalizedProject, branch ?? null);
          await storage.save(observationPayload);
        } else {
          throw saveErr;
        }
      }

      await reply.send({ status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(400).send({ error: msg });
    }
  });

  // POST /capture/prompt — save one user prompt from a remote hook
  fastify.post('/capture/prompt', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;

      const sessionId = strBound(body['session_id'], SESSION_ID_MAX, 'session_id');
      const project = strBound(body['project'], PROJECT_MAX, 'project');
      const promptText = sanitizeContent(strBound(body['prompt_text'], PROMPT_TEXT_MAX, 'prompt_text'));

      const promptNumber =
        typeof body['prompt_number'] === 'number'
          ? Math.max(0, Math.floor(body['prompt_number']))
          : 0;

      const rawPromptCreatedAt = body['created_at'];
      const createdAt =
        typeof rawPromptCreatedAt === 'string' && !isNaN(Date.parse(rawPromptCreatedAt))
          ? rawPromptCreatedAt
          : new Date().toISOString();

      const normalizedProject = findProjectRoot(normalizePath(project, pathMap));

      await storage.saveUserPrompt({
        session_id: sessionId,
        project: normalizedProject,
        prompt_number: promptNumber,
        prompt_text: promptText,
        created_at: createdAt,
      });

      await reply.send({ status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(400).send({ error: msg });
    }
  });

  // POST /capture/add — save a manual observation from context_add MCP tool.
  // Accepts { text, project, importance_score?, tags? } and returns { status, session_id }.
  fastify.post('/capture/add', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;

      const text = strBound(body['text'], OBS_SUMMARY_MAX, 'text');
      const project = strBound(body['project'], PROJECT_MAX, 'project');

      const rawScore = body['importance_score'];
      const importanceScore =
        typeof rawScore === 'number'
          ? Math.max(0.0, Math.min(1.0, rawScore))
          : 0.60;

      const rawTags = body['tags'];
      const tags =
        typeof rawTags === 'string' && rawTags.trim().length > 0
          ? rawTags.substring(0, 256)
          : undefined;

      const rawClient = body['client'];
      const client =
        typeof rawClient === 'string' && rawClient.trim().length > 0
          ? rawClient.trim().substring(0, 50)
          : undefined;

      const normalizedProject = findProjectRoot(normalizePath(project, pathMap));
      const sessionId = await storage.getOrCreateManualSession(normalizedProject);
      const obsId = await storage.addManualObservation({
        text,
        project: normalizedProject,
        sessionId,
        importanceScore,
        tags,
        client,
      });

      await reply.send({ status: 'ok', session_id: sessionId, stored: obsId !== undefined });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(400).send({ error: msg });
    }
  });

  // POST /capture/decision — save a decision captured by the Stop hook in proxy mode.
  // Accepts the Decision fields and calls storage.saveDecision().
  fastify.post('/capture/decision', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;

      const sessionId = strBound(body['session_id'], SESSION_ID_MAX, 'session_id');
      const project = strBound(body['project'], PROJECT_MAX, 'project');
      const decisionText = strBound(body['decision_text'], OBS_SUMMARY_MAX, 'decision_text');

      const context =
        typeof body['context'] === 'string' && body['context'].length > 0
          ? body['context'].substring(0, 1024)
          : null;

      const decisionNumber =
        typeof body['decision_number'] === 'number'
          ? Math.max(1, Math.floor(body['decision_number']))
          : null;

      const rawCapturedAt = body['captured_at'];
      const capturedAt =
        typeof rawCapturedAt === 'string' && !isNaN(Date.parse(rawCapturedAt))
          ? rawCapturedAt
          : new Date().toISOString();

      const importanceScore =
        typeof body['importance_score'] === 'number'
          ? Math.max(0.0, Math.min(1.0, body['importance_score']))
          : 0.7;

      const rawTags = body['tags'];
      const tags =
        typeof rawTags === 'string' && rawTags.trim().length > 0
          ? rawTags.substring(0, 256)
          : null;

      const normalizedProject = findProjectRoot(normalizePath(project, pathMap));

      await storage.saveDecision({
        session_id: sessionId,
        project: normalizedProject,
        decision_text: decisionText,
        context,
        decision_number: decisionNumber,
        captured_at: capturedAt,
        importance_score: importanceScore,
        tags,
      });

      await reply.send({ status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(400).send({ error: msg });
    }
  });

  // POST /capture/export — trigger server-side memory export for a project.
  // The server runs exportToAutoMemory(), writes its local memory file,
  // and returns the full file content so the caller can inject it at SessionStart.
  fastify.post('/capture/export', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const project = strBound(body['project'], PROJECT_MAX, 'project');
      const sessionId =
        typeof body['session_id'] === 'string' && body['session_id'].length > 0
          ? body['session_id']
          : undefined;

      const normalizedProject = normalizePath(project, pathMap);
      const result = await exportToAutoMemory(storage, normalizedProject, sessionId);

      // Read the file (even if this call exported nothing, previous exports may exist)
      let content = '';
      const memFile = join(resolveMemoryDir(normalizedProject), 'context-manager-activity.md');
      try {
        content = readFileSync(memFile, 'utf-8');
      } catch {
        // File does not exist yet
      }

      await reply.send({ status: 'ok', exported: result.exported, content });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(500).send({ error: msg });
    }
  });

  // GET /api/decisions/next-number: return the next sequential decision number for a project.
  // Used by the Stop hook in remote mode to assign globally-correct decision numbers
  // instead of always starting from 1 per session.
  fastify.get('/api/decisions/next-number', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query['project'];

      if (!project || project.length === 0 || project.length > PROJECT_MAX) {
        await reply.status(400).send({ error: 'project query parameter is required' });
        return;
      }

      const normalizedProject = findProjectRoot(normalizePath(project, pathMap));
      const nextNumber = await storage.getNextDecisionNumber(normalizedProject);
      await reply.send({ nextNumber });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(500).send({ error: msg });
    }
  });

  // GET /memory — return the current memory export file content for a project.
  // Used by the SessionStart hook to fetch context from the server without
  // triggering a new export (read-only, no side effects).
  fastify.get('/memory', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query['project'];

      if (!project || project.length === 0 || project.length > PROJECT_MAX) {
        await reply.status(400).send({ error: 'project query parameter is required' });
        return;
      }

      const normalizedProject = normalizePath(project, pathMap);
      const memFile = join(resolveMemoryDir(normalizedProject), 'context-manager-activity.md');

      let content = '';
      try {
        content = readFileSync(memFile, 'utf-8');
      } catch {
        // File does not exist — return empty content (not an error)
      }

      await reply.send({ content });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reply.status(500).send({ error: msg });
    }
  });

  // MCP endpoint: stateless mode, one transport instance per request.
  // enableJsonResponse: true forces JSON responses instead of SSE streams,
  // which is required for the proxy model (proxyToolCall uses response.json()).
  // Without this the transport defaults to SSE, breaking the proxy's JSON parsing.
  fastify.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: no persistent session tracking
        enableJsonResponse: true,      // required: proxy consumer calls response.json()
      });

      const mcpServer = createContextManagerServer(storage, { pathMap, version: SERVER_VERSION });
      await mcpServer.connect(transport);

      // hijack() must be called before handleRequest() writes to reply.raw,
      // otherwise Fastify will attempt a second response on route handler resolution.
      reply.hijack();
      await transport.handleRequest(
        request.raw,
        reply.raw,
        request.body as Record<string, unknown> | null | undefined
      );
    },
  });

  // Set up the abort controller before defining shutdown so both closures share it.
  const abortController = new AbortController();

  // Graceful shutdown on SIGINT / SIGTERM.
  // Order matters:
  //   1. Abort background loops (embed + compact) so they exit cleanly.
  //   2. Wait for both loops to fully resolve (up to 10s — MiniLM batches are
  //      ~50ms, compaction is a fast SQLite transaction; this is generous).
  //   3. Dispose the ONNX pipeline — handles the clean case where threads are
  //      already idle after the embed loop drains.
  //   4. Close Fastify, then SQLite.
  //   5. SIGKILL watchdog (1s, unref'd): fallback for when onnxruntime-node
  //      thread pool threads survive disposal and hold the event loop open.
  //      SIGKILL bypasses V8 teardown, avoiding the libc++ mutex race (#114).
  //      Natural exit fires instead if Node.js drains on its own.
  let embedTask: Promise<void> | undefined;
  let compactTask: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('[context-manager-http] Shutting down...');
    abortController.abort();
    const backgroundTasks = [
      embedTask?.catch(() => {}),
      compactTask?.catch(() => {}),
    ].filter(Boolean) as Promise<void>[];
    if (backgroundTasks.length > 0) {
      await Promise.race([
        Promise.all(backgroundTasks),
        new Promise(resolve => setTimeout(resolve, 10000)),
      ]);
    }
    // Dispose ONNX pipeline to join its thread pool threads before V8 teardown.
    await getEmbeddingService().dispose();
    await fastify.close();
    await storage.close();
    // process.exit(0) triggers V8 teardown which races against onnxruntime-node
    // thread pool threads, causing: libc++abi: mutex lock failed: Invalid argument (#114).
    // SIGKILL watchdog bypasses V8 teardown. WAL mode is crash-safe on hard kills.
    setTimeout(() => { process.kill(process.pid, 'SIGKILL'); }, 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start listening
  try {
    await fastify.listen({ port, host });
    console.error(`[context-manager-http] Server listening on http://${host}:${port}`);
    console.error(`[context-manager-http] MCP endpoint: http://${host}:${port}/mcp`);
    // Start the background embed loop. Keep a reference so shutdown() can await it.
    embedTask = backgroundEmbed(storage, abortController.signal);
    embedTask.catch((err) => {
      if (!abortController.signal.aborted) {
        console.error('[context-manager-http] Background embedding uncaught error:', err);
      }
    });
    // Start the background compaction loop. Shares the same abort signal as the embed loop.
    compactTask = backgroundCompact(storage, abortController.signal);
    compactTask.catch((err) => {
      if (!abortController.signal.aborted) {
        console.error('[context-manager-http] Background compaction uncaught error:', err);
      }
    });
  } catch (err) {
    console.error('[context-manager-http] Failed to start:', err);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await storage.close();
    process.exit(1);
  }
}
