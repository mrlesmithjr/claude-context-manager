/**
 * MCP Server for claude-context-manager (stdio entry point)
 *
 * Exposes context-manager query capabilities as MCP tools.
 * Reads from the same SQLite database that the plugin hooks write to.
 *
 * Runs as a stdio MCP server, registered via the plugin's .mcp.json.
 *
 * Proxy mode: when CONTEXT_MANAGER_URL is set, tool calls are forwarded to
 * the remote HTTP MCP server instead of executing locally. This allows
 * developer laptops to share context captured on a central host.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SQLiteStorage } from '../storage/sqlite.js';
import { getEmbeddingService } from '../embedding/service.js';
import { buildSessionEmbeddingText } from '../embedding/enrichment.js';
import { createContextManagerServer } from './create-server.js';
import { loadPathPrefixMap } from '../utils/path-map.js';

/**
 * Load environment variables from ~/.claude-context/.env into process.env.
 *
 * Claude Code injects settings.json `env` vars into hook subprocesses but NOT
 * into stdio MCP server processes (spawned via .mcp.json). Reading the shared
 * .env file at startup ensures CONTEXT_MANAGER_URL and CONTEXT_MANAGER_TOKEN
 * are available so proxy mode activates correctly.
 *
 * Existing process.env values are never overridden (explicit env vars win).
 */
function loadDotEnv(): void {
  const envPath = join(homedir(), '.claude-context', '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip matching surrounding quotes added by manual edits (e.g. VAR="value")
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (err: unknown) {
    // ENOENT: .env file is optional, silently skip
    // Any other error (EACCES etc.) is worth surfacing
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[context-manager-mcp] Warning: could not read ~/.claude-context/.env:', (err instanceof Error ? err.message : String(err)));
    }
  }
}

loadDotEnv();

// Proxy configuration: when set, all tool calls are forwarded to the remote server
const REMOTE_URL = process.env.CONTEXT_MANAGER_URL || '';
const REMOTE_TOKEN = process.env.CONTEXT_MANAGER_TOKEN || '';

let storage: SQLiteStorage | null = null;

async function getStorage(): Promise<SQLiteStorage> {
  if (!storage) {
    storage = new SQLiteStorage();
    await storage.initialize();
  }
  return storage;
}

// --- Background Embedding ---

/**
 * Embed observations in the background after MCP server starts.
 * Runs in batches with a delay between each to avoid hogging resources.
 * Silently skips if dependencies aren't installed yet (first context_embed
 * call will trigger auto-install and future startups will embed automatically).
 *
 * Skipped entirely in proxy mode. The remote server handles its own embedding.
 */
async function backgroundEmbed(): Promise<void> {
  if (REMOTE_URL) return;

  // Short delay to let the server finish startup
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    const db = await getStorage();
    if (!await db.isVectorSearchEnabled()) return;

    // Check if there's anything to embed
    const pending = db.countUnembedded();
    if (pending === 0) return;

    const embeddingService = getEmbeddingService();

    // Only proceed if transformers is already installed.
    // Don't auto-install in background. That's a first-run experience
    // that should happen via explicit context_embed call.
    const { status } = embeddingService.getStatus();
    if (status === 'unavailable') return;

    const loaded = await embeddingService.load();
    if (!loaded) return;

    console.error(`[context-manager-mcp] Background embedding: ${pending} observations pending`);

    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 500; // pause between batches to stay gentle
    let totalEmbedded = 0;

    while (true) {
      const batch = await db.getUnembeddedObservations(BATCH_SIZE);
      if (batch.length === 0) break;

      const texts = batch.map(obs => {
        const parts = [obs.summary];
        if (obs.files_touched.length > 0) {
          parts.push(obs.files_touched.join(', '));
        }
        return parts.join(' | ');
      });

      const embeddings = await embeddingService.embedBatch(texts);
      if (!embeddings) break;

      for (let j = 0; j < batch.length; j++) {
        const obs = batch[j];
        const emb = embeddings[j];
        if (!obs?.id || !emb) continue;
        try {
          await db.saveEmbedding(obs.id, emb);
          totalEmbedded++;
        } catch {
          // skip individual failures
        }
      }

      // Pause between batches
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }

    if (totalEmbedded > 0) {
      console.error(`[context-manager-mcp] Background embedding complete: ${totalEmbedded} observations embedded`);
    }

    // --- Session embeddings ---
    const pendingSessions = await db.countUnembeddedSessions();
    if (pendingSessions > 0) {
      console.error(`[context-manager-mcp] Background session embedding: ${pendingSessions} sessions pending`);

      let totalSessionEmbedded = 0;
      const sessionBatch = await db.getUnembeddedSessions(50);

      for (const session of sessionBatch) {
        try {
          const prompts = await db.getSessionPrompts(session.id);
          const observations = await db.getSessionObservations(session.id);

          const enrichedText = buildSessionEmbeddingText(prompts, observations, session.summary);
          if (enrichedText.length < 20) continue;

          const sessionEmb = await embeddingService.embed(enrichedText);
          if (sessionEmb) {
            await db.saveSessionEmbedding(session.id, sessionEmb, enrichedText);
            totalSessionEmbedded++;
          }
        } catch {
          // skip individual failures
        }

        // Brief pause between sessions
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (totalSessionEmbedded > 0) {
        console.error(`[context-manager-mcp] Background session embedding complete: ${totalSessionEmbedded} sessions embedded`);
      }
    }
  } catch (err) {
    // Background task should never crash the server
    console.error('[context-manager-mcp] Background embedding error:', err);
  }
}

// --- Server Startup ---

async function main() {
  // All logging must go to stderr. Stdout is reserved for MCP protocol.
  console.error('[context-manager-mcp] Starting MCP server...');

  if (REMOTE_URL) {
    console.error(`[context-manager-mcp] Proxy mode: forwarding tool calls to ${REMOTE_URL}`);
    if (!REMOTE_TOKEN) {
      console.error('[context-manager-mcp] WARNING: CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is empty. Remote calls will fail auth.');
    }
  }

  const db = await getStorage();
  const pathMap = loadPathPrefixMap();

  const server = createContextManagerServer(db, {
    remoteUrl: REMOTE_URL,
    remoteToken: REMOTE_TOKEN,
    pathMap,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[context-manager-mcp] MCP server connected via stdio');

  // Start background embedding (fire-and-forget, skipped in proxy mode)
  backgroundEmbed();

  // Graceful shutdown
  // Note: close() is synchronous under the hood (Promise.resolve wrapper).
  // Node.js does not await Promises returned by signal handlers, but the
  // synchronous SQLite close completes before process.exit() is reached.
  process.on('SIGINT', async () => {
    console.error('[context-manager-mcp] Shutting down...');
    await storage?.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[context-manager-mcp] Shutting down...');
    await storage?.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[context-manager-mcp] Fatal error:', error);
  // close() is Promise.resolve() over a synchronous call, safe to fire-and-forget before exit
  void storage?.close();
  process.exit(1);
});
