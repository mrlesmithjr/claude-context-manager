#!/usr/bin/env node
/**
 * E2E HTTP server entry point.
 *
 * Starts the context-manager HTTP MCP server using the tsc-compiled dist/
 * output rather than the esbuild-bundled dist/cli.js. This avoids a CJS/ESM
 * incompatibility where esbuild inlines fastify's internal require() calls
 * into an ESM bundle, which Node.js rejects at runtime.
 *
 * All configuration is read from environment variables (set by docker-compose.e2e.yml):
 *   CONTEXT_MANAGER_TOKEN   required: bearer token for auth
 *   CONTEXT_MANAGER_DB      database path (default: /data/context.db)
 *   CONTEXT_MANAGER_PORT    port to listen on (default: 4000)
 *   CONTEXT_MANAGER_HOST    bind address (default: 0.0.0.0)
 *   LOG_LEVEL               fastify log level (default: info)
 */

import { startHttpServer } from '../../dist/server/http.js';

await startHttpServer();
