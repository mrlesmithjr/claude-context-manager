/**
 * API Routes for Context Manager Web Dashboard
 */

import fs from 'fs';
import type { FastifyInstance } from 'fastify';
import type { ContextStorage } from '../../../src/storage/interface.js';
import type { SQLiteStorage } from '../../../src/storage/sqlite.js';

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

  // POST /api/import — import a context.db file into the active database.
  // Network mode: protected by the global Bearer auth hook in index.ts.
  // Local mode: no auth; access is limited to processes on the local machine.
  fastify.post('/api/import', async (request, reply) => {
    let data: Awaited<ReturnType<typeof request.file>>;
    try {
      data = await request.file();
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string };
      if (e?.statusCode === 406 || e?.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
        reply.status(400).send({ error: 'Request must be multipart/form-data' });
        return;
      }
      throw err;
    }
    if (!data) {
      reply.status(400).send({ error: 'No file uploaded' });
      return;
    }

    // Path uses only [0-9a-z.-] — safe for direct SQL interpolation.
    // Do NOT add user-supplied input to this path.
    const tmpPath = `/tmp/ctx-import-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    try {
      // Buffer the upload so we can inspect the magic bytes before writing to disk.
      const buf = await data.toBuffer();

      // Validate SQLite magic bytes: first 16 bytes must be "SQLite format 3\0"
      const magic = Buffer.from('SQLite format 3\x00');
      if (buf.length < 16 || !buf.subarray(0, 16).equals(magic)) {
        reply.status(400).send({ error: 'Uploaded file is not a valid SQLite database' });
        return;
      }

      fs.writeFileSync(tmpPath, buf);

      const db = (storage as SQLiteStorage).rawDb;

      db.exec(`ATTACH DATABASE '${tmpPath}' AS src`);
      try {
        // Verify the source DB has the migration-added columns we SELECT from.
        const srcCols = (db.prepare('PRAGMA src.table_info(observations)').all() as Array<{ name: string }>)
          .map((c: { name: string }) => c.name);
        const requiredCols = ['importance', 'importance_score', 'tags', 'content_hash'];
        const missingCols = requiredCols.filter(c => !srcCols.includes(c));
        if (missingCols.length > 0) {
          reply.status(400).send({
            error: `Source database schema is too old. Missing columns: ${missingCols.join(', ')}. ` +
                   `Start the context manager on the source machine once to apply migrations, then re-export.`,
          });
          return;
        }

        // observation_relationships: skipped — integer IDs from src don't map to main IDs
        // vec_observations / vec_sessions: skipped — virtual tables, not ATTACH-copyable
        const results = db.transaction(() => {
          // sessions: dedup via TEXT PRIMARY KEY (id)
          const sessionsResult = db.prepare(`
            INSERT OR IGNORE INTO main.sessions
            SELECT * FROM src.sessions
          `).run();

          // observations: exclude AUTOINCREMENT id; dedup via unique partial index
          // on (project, content_hash). Only rows with a content_hash can be safely deduped.
          const obsResult = db.prepare(`
            INSERT OR IGNORE INTO main.observations
              (session_id, project, package, tool_name, summary, files_touched,
               metadata, token_estimate, created_at, importance, importance_score,
               tags, content_hash)
            SELECT
              session_id, project, package, tool_name, summary, files_touched,
              metadata, token_estimate, created_at, importance, importance_score,
              tags, content_hash
            FROM src.observations
            WHERE content_hash IS NOT NULL
          `).run();

          // user_prompts: exclude AUTOINCREMENT id; dedup by (session_id, prompt_number)
          const promptsResult = db.prepare(`
            INSERT OR IGNORE INTO main.user_prompts
              (session_id, project, prompt_number, prompt_text, created_at)
            SELECT
              session_id, project, prompt_number, prompt_text, created_at
            FROM src.user_prompts
            WHERE NOT EXISTS (
              SELECT 1 FROM main.user_prompts up2
              WHERE up2.session_id = src.user_prompts.session_id
                AND up2.prompt_number = src.user_prompts.prompt_number
            )
          `).run();

          // file_encounter_counts: dedup via composite PRIMARY KEY (file_path, project, tool_name)
          const fileCountsResult = db.prepare(`
            INSERT OR IGNORE INTO main.file_encounter_counts
            SELECT * FROM src.file_encounter_counts
          `).run();

          return { sessionsResult, obsResult, promptsResult, fileCountsResult };
        })();

        reply.send({
          imported: {
            observations: results.obsResult.changes,
            sessions: results.sessionsResult.changes,
            prompts: results.promptsResult.changes,
            file_counts: results.fileCountsResult.changes,
          },
          skipped: ['observation_relationships', 'vec_observations', 'vec_sessions'],
          note: 'Run context_embed in any Claude Code session to regenerate vector embeddings',
        });
      } finally {
        try { db.exec('DETACH DATABASE src'); } catch { /* ignore if attach failed */ }
      }
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Import failed' });
    } finally {
      // Always clean up the temp file regardless of success or failure
      try { fs.unlinkSync(tmpPath); } catch { /* ignore if file was never written */ }
    }
  });
}
