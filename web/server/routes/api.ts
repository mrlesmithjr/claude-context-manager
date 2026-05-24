/**
 * API Routes for Context Manager Web Dashboard
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ContextStorage } from '../../../src/storage/interface.js';

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

export async function registerApiRoutes(
  fastify: FastifyInstance,
  storage: ContextStorage
) {
  // GET /api/sessions - List sessions with filtering
  fastify.get<{ Querystring: SessionsQuerystring }>(
    '/api/sessions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            status: { type: 'string', enum: ['active', 'complete'] },
            limit: { type: 'number', minimum: 1, maximum: 200 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { project, status, limit = 50, offset = 0 } = request.query;

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
            q: { type: 'string' },
            project: { type: 'string' },
            tool: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: 200 },
            offset: { type: 'number', minimum: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { q, project, tool, limit = 50, offset = 0 } = request.query;

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
            project: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { project } = request.query;

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
            project: { type: 'string' },
            days: { type: 'number', minimum: 1, maximum: 365 },
          },
        },
      },
    },
    async (request, reply) => {
      const { project, days = 30 } = request.query;

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
  fastify.get('/api/projects', async (request, reply) => {
    try {
      const projects = await storage.getProjects();
      reply.send({ projects });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to retrieve projects' });
    }
  });
}
