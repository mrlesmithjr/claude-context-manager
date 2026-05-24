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
import { join } from 'path';
import { createContextManagerServer } from '../mcp/create-server.js';
import { SQLiteStorage } from '../storage/sqlite.js';
import { loadPathPrefixMap } from '../utils/path-map.js';

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
    await reply.send({ status: 'ok', mode: 'http-mcp' });
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

      const mcpServer = createContextManagerServer(storage, { pathMap });
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

  // Start listening
  try {
    await fastify.listen({ port, host });
    console.error(`[context-manager-http] Server listening on http://${host}:${port}`);
    console.error(`[context-manager-http] MCP endpoint: http://${host}:${port}/mcp`);
    // TODO(#1 phase 8): background embedding is not yet started in HTTP server mode.
    // Hook-proxied observations written to the server will need an explicit context_embed
    // call to generate embeddings. Add a backgroundEmbed() call here once the embedding
    // service is verified safe for long-running server processes with sqlite-vec.
  } catch (err) {
    console.error('[context-manager-http] Failed to start:', err);
    await storage.close();
    process.exit(1);
  }

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async () => {
    console.error('[context-manager-http] Shutting down...');
    await fastify.close();
    await storage.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
