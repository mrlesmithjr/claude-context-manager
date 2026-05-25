/**
 * Context Manager Web Dashboard Server
 *
 * Fastify server providing REST API for browsing context observations.
 * Binds to localhost:3847 by default.
 *
 * Security controls active in network mode (HOST != localhost/127.0.0.1):
 *   - Bearer token authentication (CONTEXT_MANAGER_TOKEN env var required)
 *   - Rate limiting (60 req/min per IP on API routes)
 *   - Input size limits on all query parameters
 *   - Project path scope validation (minimum depth 3)
 *   - Explicit CORS allowlist (no wildcard)
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { SQLiteStorage } from '../../src/storage/sqlite.js';
import { registerApiRoutes } from './routes/api.js';

// Support both ESM (dev: dist/web/server.js) and CJS (plugin: scripts/web/index.js)
const __scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

// Configuration from environment
const PORT = parseInt(process.env.CONTEXT_MANAGER_PORT || '3847', 10);
const HOST = process.env.CONTEXT_MANAGER_HOST || 'localhost';
const DB_PATH =
  process.env.CONTEXT_MANAGER_DB ||
  join(homedir(), '.claude-context', 'context.db');
const TOKEN = process.env.CONTEXT_MANAGER_TOKEN || '';

// Network mode: any host other than loopback
const LOCALHOST_VARIANTS = new Set(['localhost', '127.0.0.1', '::1']);
const isNetworkMode = !LOCALHOST_VARIANTS.has(HOST);

async function main() {
  // Enforce bearer token requirement in network mode
  if (isNetworkMode && !TOKEN) {
    console.error(
      '[context-manager] ERROR: CONTEXT_MANAGER_TOKEN must be set when binding to a non-localhost address.\n' +
      '  Generate a token: openssl rand -hex 32'
    );
    process.exit(1);
  }

  if (isNetworkMode) {
    console.log('[context-manager] Network mode enabled: bearer token auth active');
  }

  // Initialize storage
  const storage = new SQLiteStorage(DB_PATH);
  await storage.initialize();

  // Create Fastify instance with access logging
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || (isNetworkMode ? 'info' : 'warn'),
    },
  });

  // Rate limiting: applied globally to all routes (60 req/min per IP).
  // In local mode, loopback IPs are allowlisted so developer workflows are unaffected.
  await fastify.register(fastifyRateLimit, {
    max: parseInt(process.env.CONTEXT_MANAGER_RATE_LIMIT || '60', 10),
    timeWindow: '1 minute',
    skipOnError: false,
    allowList: LOCALHOST_VARIANTS.has(HOST) ? ['127.0.0.1', '::1', '::ffff:127.0.0.1'] : [],
  });

  // Bearer token auth: enforced on all routes in network mode
  if (isNetworkMode) {
    fastify.addHook('onRequest', async (request, reply) => {
      // Allow the health check and the root page without auth.
      // The root page (GET /) injects the token into HTML; a browser visiting for
      // the first time has no token yet so it must load without auth first.
      const rawPath = request.url.split('?')[0];
      if (rawPath === '/api/health' || rawPath === '/') return;

      const authHeader = request.headers['authorization'] || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

      // Constant-time comparison using crypto.timingSafeEqual to prevent timing oracle.
      // Both buffers must be the same length: we allocate expected.length and copy
      // from provided, so a wrong-length token still does a full fixed-work compare.
      const expected = Buffer.from(TOKEN);
      const actual = Buffer.alloc(expected.length);
      Buffer.from(provided).copy(actual, 0, 0, expected.length);
      const lengthMatch = provided.length === TOKEN.length;
      const contentMatch = timingSafeEqual(expected, actual);

      if (!lengthMatch || !contentMatch) {
        reply.status(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' });
      }
    });
  }

  // CORS: explicit allowlist, no wildcard
  const allowedOrigins = isNetworkMode
    ? [`http://${HOST}:${PORT}`, `https://${HOST}:${PORT}`]
    : [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`];

  await fastify.register(fastifyCors, {
    origin: allowedOrigins,
  });

  // Register static file serving for client
  // Supports both dev (dist/web/server.js -> web/client) and plugin (scripts/web/index.js -> scripts/web/client)
  const clientPath = existsSync(join(__scriptDir, 'client'))
    ? join(__scriptDir, 'client')
    : join(__scriptDir, '..', '..', 'web', 'client');
  await fastify.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
    // index.html is served dynamically via GET / below — disable auto-index serving
    index: false,
  });

  // Dynamic GET / : serve index.html with token injected so the browser client
  // can attach Bearer auth headers in network mode.
  // In local mode token is an empty string and the client adds no header.
  fastify.get('/', async (_request, reply) => {
    const indexPath = join(clientPath, 'index.html');
    if (!existsSync(indexPath)) {
      reply.status(503).send({ error: 'Dashboard not built. Run npm run build:plugin.' });
      return;
    }
    const raw = readFileSync(indexPath, 'utf8');
    const tokenValue = isNetworkMode ? TOKEN : '';
    const safeToken = JSON.stringify(tokenValue).replace(/<\/script>/gi, '<\\/script>');
    const injected = raw.replace(
      '</head>',
      `<script>window.__CTX_TOKEN = ${safeToken};</script>\n</head>`
    );
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(injected);
  });

  // Register API routes (pass network mode flag for scope validation)
  await registerApiRoutes(fastify, storage, isNetworkMode);

  // Health check endpoint: no auth required, no sensitive data exposed
  fastify.get('/api/health', async (request, reply) => {
    reply.send({
      status: 'ok',
      version: process.env.npm_package_version || 'unknown',
    });
  });

  // Start server
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`
┌──────────────────────────────────────────────────┐
│  Context Manager Dashboard                        │
├──────────────────────────────────────────────────┤
│  Server:   http://${HOST}:${PORT}         │
│  Database: ${DB_PATH}                             │
└──────────────────────────────────────────────────┘

Press Ctrl+C to stop
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await fastify.close();
    await storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
