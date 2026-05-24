/**
 * API Routes for Context Manager Web Dashboard
 */

import type { FastifyInstance } from 'fastify';
import type { ContextStorage } from '../../../src/storage/interface.js';

// Maximum lengths for string query parameters.
// These prevent unbounded FTS5 queries and oversized project paths.
const MAX_QUERY_LEN = 500;
const MAX_PROJECT_LEN = 1024;
const MAX_TOOL_LEN = 64;

interface SessionsQuerystring {
  project?: string;
  status?: 'active' | 'complete';
  limit?: number;
  offset?: number;
}

interface ObservationsQuerystring {
  q?: string;
  project?: string;
  tool?: string;
  limit?: number;
  offset?: number;
}

interface StatsQuerystring {
  project?: string;
}

interface TimelineQuerystring {
  project?: string;
  days?: number;
}

// Minimum project path depth required in network mode (non-localhost).
// Prevents "project=/" or "project=/Users" from exposing all data.
// Set CONTEXT_MANAGER_PROJECT_PREFIX to require a specific prefix
// (e.g. "/Users/alice/Projects") as an additional constraint.
const NETWORK_MIN_DEPTH = parseInt(process.env.CONTEXT_MANAGER_MIN_DEPTH || '3', 10);
const REQUIRED_PREFIX = process.env.CONTEXT_MANAGER_PROJECT_PREFIX || '';

/**
 * Returns true if the project path is too broad for safe use in network mode.
 * A depth-3 path like "/Users/alice/Projects" is allowed; "/" and "/Users" are not.
 * Unix paths only (slash-delimited) — this is a macOS/Linux personal tool.
 */
function isProjectTooBroad(project: string, isNetworkMode: boolean): boolean {
  if (!isNetworkMode) return false;
  const depth = project.split('/').filter(Boolean).length;
  if (depth < NETWORK_MIN_DEPTH) return true;
  if (REQUIRED_PREFIX && !project.startsWith(REQUIRED_PREFIX)) return true;
  return false;
}

export async function registerApiRoutes(
  fastify: FastifyInstance,
  storage: ContextStorage,
  isNetworkMode: boolean = false
) {
  // GET /api/sessions - List sessions with filtering
  fastify.get<{ Querystring: SessionsQuerystring }>(
    '/api/sessions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string', maxLength: MAX_PROJECT_LEN },
            status: { type: 'string', enum: ['active', 'complete'] },
            limit: { type: 'number', minimum: 1, maximum: 200 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { project, status, limit = 50, offset = 0 } = request.query;

      if (isNetworkMode && !project) {
        reply.status(400).send({ error: 'project parameter is required in network mode' });
        return;
      }
      if (project && isProjectTooBroad(project, isNetworkMode)) {
        reply.status(403).send({ error: 'Project path too broad for network mode' });
        return;
      }

      try {
        // Get total count and paginated sessions with observation stats in two
        // queries instead of the previous N+1 pattern (1 + N per session).
        const [total, sessions] = await Promise.all([
          storage.countSessions(project, status),
          storage.getRecentSessionsWithCounts(
            project || '/',
            limit,
            offset,
            status
          ),
        ]);

        reply.send({
          sessions,
          total,
          limit,
          offset,
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: 'Failed to retrieve sessions' });
      }
    }
  );

  // GET /api/sessions/:id - Get session detail
  fastify.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;

      try {
        // Get session info from observations (we don't have a getSession method yet)
        const observations = await storage.getSessionObservations(id);
        const prompts = await storage.getSessionPrompts(id);

        if (observations.length === 0 && prompts.length === 0) {
          reply.status(404).send({ error: 'Session not found' });
          return;
        }

        // Build session object from observations
        const project = observations[0]?.project || prompts[0]?.project || '';

        // In network mode, reject sessions whose project path is too broad.
        // This prevents an authenticated caller from enumerating arbitrary sessions.
        if (isNetworkMode && isProjectTooBroad(project, isNetworkMode)) {
          reply.status(403).send({ error: 'Session project path too broad for network mode' });
          return;
        }

        const session = {
          id,
          project,
          started_at:
            observations[0]?.created_at || prompts[0]?.created_at || '',
          ended_at: observations[observations.length - 1]?.created_at,
          status: 'complete' as const,
        };

        reply.send({
          session,
          observations,
          prompts,
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: 'Failed to retrieve session' });
      }
    }
  );

  // GET /api/observations - Search/list observations
  fastify.get<{ Querystring: ObservationsQuerystring }>(
    '/api/observations',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: MAX_QUERY_LEN },
            project: { type: 'string', maxLength: MAX_PROJECT_LEN },
            tool: { type: 'string', maxLength: MAX_TOOL_LEN },
            limit: { type: 'number', minimum: 1, maximum: 200 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { q, project, tool, limit = 50, offset = 0 } = request.query;

      if (isNetworkMode && !project) {
        reply.status(400).send({ error: 'project parameter is required in network mode' });
        return;
      }
      if (project && isProjectTooBroad(project, isNetworkMode)) {
        reply.status(403).send({ error: 'Project path too broad for network mode' });
        return;
      }

      try {
        let observations;

        if (q) {
          // Full-text search
          observations = await storage.search(q, project);
        } else {
          // Get recent observations
          observations = await storage.getRecent(
            project || '',
            limit + offset
          );
        }

        // Filter by tool if specified
        if (tool) {
          observations = observations.filter((obs) => obs.tool_name === tool);
        }

        // Get total count
        const total = await storage.countObservations(project, tool);

        // Apply pagination
        const paginatedObservations = observations.slice(
          offset,
          offset + limit
        );

        reply.send({
          observations: paginatedObservations,
          total,
          limit,
          offset,
        });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: 'Failed to retrieve observations' });
      }
    }
  );

  // GET /api/stats - Get statistics
  fastify.get<{ Querystring: StatsQuerystring }>(
    '/api/stats',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string', maxLength: MAX_PROJECT_LEN },
          },
        },
      },
    },
    async (request, reply) => {
      const { project } = request.query;

      if (isNetworkMode && !project) {
        reply.status(400).send({ error: 'project parameter is required in network mode' });
        return;
      }
      if (project && isProjectTooBroad(project, isNetworkMode)) {
        reply.status(403).send({ error: 'Project path too broad for network mode' });
        return;
      }

      try {
        const stats = await storage.getStats(project);
        reply.send(stats);
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: 'Failed to retrieve statistics' });
      }
    }
  );

  // GET /api/stats/timeline - Get timeline for analytics
  fastify.get<{ Querystring: TimelineQuerystring }>(
    '/api/stats/timeline',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string', maxLength: MAX_PROJECT_LEN },
            days: { type: 'number', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (request, reply) => {
      const { project, days = 30 } = request.query;

      if (isNetworkMode && !project) {
        reply.status(400).send({ error: 'project parameter is required in network mode' });
        return;
      }
      if (project && isProjectTooBroad(project, isNetworkMode)) {
        reply.status(403).send({ error: 'Project path too broad for network mode' });
        return;
      }

      try {
        const timeline = await storage.getTimeline(project, days);
        reply.send({ timeline });
      } catch (error) {
        fastify.log.error(error);
        reply.status(500).send({ error: 'Failed to retrieve timeline' });
      }
    }
  );

  // GET /api/projects - Get list of projects
  // In network mode, project paths are filtered to those matching CONTEXT_MANAGER_PROJECT_PREFIX
  // (if set) to avoid exposing the full local filesystem layout to callers.
  fastify.get('/api/projects', async (request, reply) => {
    try {
      let projects = await storage.getProjects();
      if (isNetworkMode && REQUIRED_PREFIX) {
        projects = projects.filter(p => p.path.startsWith(REQUIRED_PREFIX));
      }
      reply.send({ projects });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to retrieve projects' });
    }
  });
}
