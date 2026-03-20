/**
 * Context Manager Web Dashboard Server
 *
 * Fastify server providing REST API for browsing context observations.
 * Binds to localhost:3847 by default.
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
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

async function main() {
  // Initialize storage
  const storage = new SQLiteStorage(DB_PATH);
  await storage.initialize();

  // Create Fastify instance
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Register CORS (allow requests from same origin)
  await fastify.register(fastifyCors, {
    origin: [`http://${HOST}:${PORT}`, `http://localhost:${PORT}`],
  });

  // Register static file serving for client
  // Supports both dev (dist/web/server.js -> web/client) and plugin (scripts/web/index.js -> scripts/web/client)
  const clientPath = existsSync(join(__scriptDir, 'client'))
    ? join(__scriptDir, 'client')
    : join(__scriptDir, '..', '..', 'web', 'client');
  await fastify.register(fastifyStatic, {
    root: clientPath,
    prefix: '/',
  });

  // Register API routes
  await registerApiRoutes(fastify, storage);

  // Health check endpoint
  fastify.get('/api/health', async (request, reply) => {
    reply.send({
      status: 'ok',
      version: process.env.npm_package_version || 'unknown',
      database: DB_PATH,
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
    storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
