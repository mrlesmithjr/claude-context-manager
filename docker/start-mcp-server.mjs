#!/usr/bin/env node
/**
 * HTTP MCP server entrypoint for Docker.
 *
 * Uses the tsc-compiled dist/server/http.js rather than the esbuild CLI bundle.
 * The esbuild bundle inlines fastify's CJS require() calls which Node.js rejects
 * in ESM modules at runtime.
 *
 * Configuration via environment variables (set by docker-compose.server.yml):
 *   CONTEXT_MANAGER_TOKEN   required: bearer token for auth
 *   CONTEXT_MANAGER_DB      database path (default: /data/context.db)
 *   CONTEXT_MANAGER_PORT    port (default: 4000)
 *   CONTEXT_MANAGER_HOST    bind address (default: 0.0.0.0)
 *   LOG_LEVEL               fastify log level (default: info)
 */

import { startHttpServer } from '../dist/server/http.js';

await startHttpServer();
