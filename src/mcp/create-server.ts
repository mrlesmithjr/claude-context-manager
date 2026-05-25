/**
 * MCP Server Factory
 *
 * Creates a configured McpServer with all context-manager tools registered.
 * Used by both the stdio entry point (server.ts) and the HTTP server (src/server/http.ts)
 * so tool registrations are never duplicated.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { SQLiteStorage } from '../storage/sqlite.js';
import {
  exportToAutoMemory,
  resolveMemoryDir,
  formatObservationsForMemory,
} from '../export/memory.js';
import { getEmbeddingService } from '../embedding/service.js';
import { buildSessionEmbeddingText } from '../embedding/enrichment.js';
import { auditMemoryDirectories, formatAuditReport } from '../memory/audit.js';
import { consolidateMemories, formatConsolidationReport } from '../memory/consolidate.js';
import type { ImportanceLevel, Observation, Session, Stats, UserPrompt } from '../storage/interface.js';
import {
  computeSessionDuration,
  extractSessionNarrative,
  countByImportance,
  formatShortDate,
} from '../utils/session-format.js';
import { classifyQuery, type QueryStrategy } from '../utils/classify.js';
import { normalizePath, type PathPrefixEntry } from '../utils/path-map.js';

// Minimum cosine similarity score for semantic/hybrid search results.
// Results below this threshold are suppressed to avoid returning low-signal noise.
// Applies to semantic path only. FTS5 (keyword) results are exact matches and always pass.
// Override via CONTEXT_SEARCH_MIN_SCORE env var.
const SEARCH_MIN_SCORE = parseFloat(process.env.CONTEXT_SEARCH_MIN_SCORE ?? '0.25');

// Version injected by esbuild; falls back for non-bundled environments (e.g., ts-node, vitest)
declare const PLUGIN_VERSION: string;

export interface ServerOptions {
  remoteUrl?: string;
  remoteToken?: string;
  pathMap?: PathPrefixEntry[];
}

/**
 * Format observations for tool output
 */
function formatObservations(observations: Observation[]): string {
  if (observations.length === 0) {
    return 'No observations found.';
  }

  const lines: string[] = [];
  for (const obs of observations) {
    const date = new Date(obs.created_at);
    const fileInfo =
      obs.files_touched.length > 0 ? ` (${obs.files_touched.join(', ')})` : '';
    const tagInfo = obs.tags && obs.tags.length > 0 ? ` [${obs.tags.join(', ')}]` : '';
    lines.push(
      `[${date.toISOString()}] ${obs.tool_name}: ${obs.summary}${fileInfo}${tagInfo}`
    );
  }
  return lines.join('\n');
}

/**
 * Parse a tag: prefix from a query string.
 * Returns { tag, remainingQuery } where tag may be null.
 * Examples: "tag:auth" -> { tag: "auth", remainingQuery: "" }
 *           "tag:database sqlite" -> { tag: "database", remainingQuery: "sqlite" }
 */
function parseTagPrefix(query: string): { tag: string | null; remainingQuery: string } {
  const match = query.match(/(?:^|\s)tag:(\w+)/i);
  if (!match) return { tag: null, remainingQuery: query };
  const tag = match[1]!.toLowerCase();
  const remainingQuery = query.replace(match[0]!, '').trim();
  return { tag, remainingQuery };
}

/**
 * Format user prompts for tool output
 */
function formatPrompts(prompts: UserPrompt[]): string {
  const lines: string[] = [];
  for (const p of prompts) {
    const date = new Date(p.created_at);
    const preview = p.prompt_text.length > 200
      ? p.prompt_text.substring(0, 200) + '...'
      : p.prompt_text;
    lines.push(`[${date.toISOString()}] User: ${preview}`);
  }
  return lines.join('\n');
}

/**
 * Format stats for tool output
 */
interface VectorStats {
  vector_search_enabled: boolean;
  embedded_count: number;
  unembedded_count: number;
  embedding_status: string;
}

function formatStats(
  stats: Stats,
  project?: string,
  vectorStats?: VectorStats,
  sessionEmbeddingStats?: { embedded: number; pending: number }
): string {
  const lines: string[] = [];

  lines.push('Context Manager Statistics');
  lines.push('');
  lines.push(project ? `Project: ${project}` : 'All Projects');
  lines.push('');

  lines.push('=== Storage ===');
  lines.push(`Total Observations: ${stats.total_observations}`);
  lines.push(`Total Sessions: ${stats.total_sessions}`);
  lines.push(
    `Date Range: ${stats.oldest_observation || 'N/A'} to ${stats.newest_observation || 'N/A'}`
  );

  lines.push('');
  lines.push('=== Token Economics ===');
  lines.push(`Total Tokens Stored: ${stats.total_tokens.toLocaleString()}`);
  lines.push(`Avg per Observation: ${stats.avg_tokens_per_observation} tokens`);
  lines.push(
    `Avg per Session: ${stats.avg_tokens_per_session.toLocaleString()} tokens`
  );

  if (Object.keys(stats.tokens_by_tool).length > 0) {
    lines.push('');
    lines.push('=== Tokens by Tool ===');
    const tools = Object.entries(stats.tokens_by_tool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [tool, tokens] of tools) {
      const pct = Math.round((tokens / stats.total_tokens) * 100);
      lines.push(`  ${tool}: ${tokens.toLocaleString()} (${pct}%)`);
    }
  }

  const imp = stats.importance_counts;
  const impTotal = imp.high + imp.medium + imp.low;
  if (impTotal > 0) {
    lines.push('');
    lines.push('=== Importance Distribution ===');
    lines.push(
      `  High:   ${imp.high.toLocaleString()} (${Math.round((imp.high / impTotal) * 100)}%)`
    );
    lines.push(
      `  Medium: ${imp.medium.toLocaleString()} (${Math.round((imp.medium / impTotal) * 100)}%)`
    );
    lines.push(
      `  Low:    ${imp.low.toLocaleString()} (${Math.round((imp.low / impTotal) * 100)}%)`
    );
  }

  if (stats.compacted_count > 0) {
    lines.push('');
    lines.push('=== Compaction ===');
    lines.push(
      `  Compacted: ${stats.compacted_count} observations (from ${stats.compacted_original_count} originals)`
    );
  }

  if (vectorStats) {
    lines.push('');
    lines.push('=== Vector Search ===');
    lines.push(`  Enabled: ${vectorStats.vector_search_enabled ? 'yes' : 'no'}`);
    if (vectorStats.vector_search_enabled) {
      lines.push('  --- Observations ---');
      const total = vectorStats.embedded_count + vectorStats.unembedded_count;
      const pct = total > 0 ? Math.round((vectorStats.embedded_count / total) * 100) : 0;
      lines.push(`  Embedded: ${vectorStats.embedded_count.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
      lines.push(`  Pending: ${vectorStats.unembedded_count.toLocaleString()}`);

      if (sessionEmbeddingStats) {
        const sessTotal = sessionEmbeddingStats.embedded + sessionEmbeddingStats.pending;
        const sessPct = sessTotal > 0 ? Math.round((sessionEmbeddingStats.embedded / sessTotal) * 100) : 0;
        lines.push('  --- Sessions (enriched) ---');
        lines.push(`  Embedded: ${sessionEmbeddingStats.embedded.toLocaleString()} / ${sessTotal.toLocaleString()} (${sessPct}%)`);
        lines.push(`  Pending: ${sessionEmbeddingStats.pending.toLocaleString()}`);
      }

      lines.push(`  Model Status: ${vectorStats.embedding_status}`);
    }
  }

  return lines.join('\n');
}

/**
 * Merge two ranked result lists using Reciprocal Rank Fusion.
 * Standard approach for combining results from different retrieval systems.
 * k=60 is the standard value from the original RRF paper.
 */
function mergeWithRRF(
  ftsResults: Observation[],
  vecResults: Observation[],
  k: number = 60,
): Observation[] {
  const scores = new Map<number, number>();
  const obsMap = new Map<number, Observation>();

  for (let i = 0; i < ftsResults.length; i++) {
    const obs = ftsResults[i]!;
    const id = obs.id!;
    obsMap.set(id, obs);
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
  }

  for (let i = 0; i < vecResults.length; i++) {
    const obs = vecResults[i]!;
    const id = obs.id!;
    obsMap.set(id, obs);
    scores.set(id, (scores.get(id) || 0) + 1 / (k + i + 1));
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id]) => obsMap.get(id)!)
    .filter(Boolean);
}

/** Typed content block as expected by McpServer tool handlers */
type TextContent = { type: 'text'; text: string };
type ToolResult = { content: TextContent[] };

/**
 * Proxy a tool call to the remote HTTP MCP server.
 * Used when remoteUrl is configured.
 *
 * Throws on any failure. Do NOT silently fall back to local storage.
 * A silent fallback would split context across two stores and corrupt search results.
 */
async function proxyToolCall(
  toolName: string,
  args: Record<string, unknown>,
  remoteUrl: string,
  remoteToken: string,
): Promise<ToolResult> {
  let response: Response;
  try {
    response = await fetch(`${remoteUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${remoteToken}`,
        // StreamableHTTPServerTransport validates that the client accepts both
        // JSON and SSE even when the server is in JSON response mode.
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: randomUUID(),
        params: { name: toolName, arguments: args },
      }),
    });
  } catch (err) {
    throw new Error(
      `[context-manager] Remote MCP server unreachable at ${remoteUrl}: ${String(err)}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const hint = response.status === 401 ? ' (check CONTEXT_MANAGER_TOKEN)' : '';
    throw new Error(
      `[context-manager] Remote MCP server returned ${response.status}${hint}: ${body}`
    );
  }

  const data = await response.json() as {
    result?: { content: Array<{ type: string; text: string }> };
    error?: { message: string };
  };

  if (data.error) {
    throw new Error(`[context-manager] Remote MCP error: ${data.error.message}`);
  }

  // Normalize the content type to the literal 'text' required by the MCP SDK
  const rawContent = data.result?.content ?? [{ type: 'text', text: 'No result from remote server' }];
  const content: TextContent[] = rawContent.map(c => ({
    type: 'text' as const,
    text: typeof c.text === 'string' ? c.text : String(c.text),
  }));

  return { content };
}

/**
 * Create a fully configured McpServer with all context-manager tools registered.
 *
 * @param storage - initialized SQLiteStorage instance
 * @param options - optional proxy and path normalization config
 */
export function createContextManagerServer(
  storage: SQLiteStorage,
  options: ServerOptions = {}
): McpServer {
  const { remoteUrl = '', remoteToken = '', pathMap = [] } = options;
  const isProxy = !!remoteUrl;

  const server = new McpServer(
    {
      name: 'context-manager',
      version: typeof PLUGIN_VERSION !== 'undefined' ? PLUGIN_VERSION : 'unknown',
    },
    {
      instructions:
        'Check context_list at session start to load relevant prior context. ' +
        'Use context_search for targeted lookups and context_semantic_search for broader discovery. ' +
        'Use context_prune for targeted cleanup by tool_name, importance, or age. Always run with dry_run=true first to preview. Requires at least one filter to prevent accidental full wipe.',
    },
  );

  // Helper: resolve storage (always the injected instance)
  const getDb = (): Promise<SQLiteStorage> => Promise.resolve(storage);

  // Helper: normalize a project path through the configured prefix map
  const np = (p: string | undefined): string | undefined =>
    p !== undefined ? normalizePath(p, pathMap) : undefined;

  // --- Tool Definitions ---

  server.tool(
    'context_search',
    'Search past Claude Code session activity. Automatically routes to the optimal search strategy: keyword (FTS5) for short/specific queries, semantic (vector similarity) for natural language, or hybrid (both merged with Reciprocal Rank Fusion) for mixed queries. Also searches user prompts and enriches results with related observations. Supports tag:X prefix to filter by domain (auth, database, testing, infra, config, frontend, api, git, build, deps).',
    {
      query: z.string().describe('Search query. Supports tag:X prefix to filter by domain tag (e.g. "tag:auth", "tag:database sqlite"). Available tags: auth, database, testing, infra, config, frontend, api, git, build, deps.'),
      project: z
        .string()
        .optional()
        .describe(
          'Project path to scope search. Omit to search all projects.'
        ),
    },
    async ({ query, project }) => {
      if (isProxy) {
        return proxyToolCall('context_search', { query, project: np(project) }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);

      // Check for tag: prefix, routes to tag search, optionally combined with keyword
      const { tag, remainingQuery } = parseTagPrefix(query);
      if (tag) {
        const tagObs = await db.searchByTag(tag, normalizedProject);
        // If there's remaining query text, further filter via FTS5
        let results = tagObs;
        if (remainingQuery.length > 0) {
          const ftsResults = await db.search(remainingQuery, normalizedProject);
          const ftsIds = new Set(ftsResults.map(o => o.id));
          results = tagObs.filter(o => ftsIds.has(o.id));
        }
        const label = remainingQuery
          ? `tag:${tag} + keyword "${remainingQuery}"`
          : `tag:${tag}`;
        const text = results.length > 0
          ? `Found ${results.length} observations (${label}):\n\n${formatObservations(results)}`
          : `No observations found for ${label}.`;
        return { content: [{ type: 'text' as const, text }] };
      }

      const strategy: QueryStrategy = classifyQuery(query);

      let observations: Observation[] = [];
      let searchMethod = '';
      let sessionResults: Session[] = [];

      if (strategy === 'keyword') {
        observations = await db.search(query, normalizedProject);
        searchMethod = 'keyword';
      } else if (strategy === 'semantic') {
        // Try semantic search; fall back to keyword if embeddings unavailable
        if (await db.isVectorSearchEnabled()) {
          const embeddingService = getEmbeddingService();
          const queryEmbedding = await embeddingService.embed(query);
          if (queryEmbedding) {
            // Try session-level first (enriched, higher quality)
            const rawSessions = await db.vectorSearchSessions(queryEmbedding, normalizedProject, 10);
            sessionResults = rawSessions.filter(
              s => s.similarity_score == null || s.similarity_score >= SEARCH_MIN_SCORE
            );
            if (sessionResults.length === 0) {
              const rawObs = await db.vectorSearch(queryEmbedding, normalizedProject, 20);
              observations = rawObs.filter(
                o => o.similarity_score == null || o.similarity_score >= SEARCH_MIN_SCORE
              );
            }
            searchMethod = 'semantic';
          } else {
            observations = await db.search(query, normalizedProject);
            searchMethod = 'keyword (embedding unavailable)';
          }
        } else {
          observations = await db.search(query, normalizedProject);
          searchMethod = 'keyword (vector search unavailable)';
        }
      } else {
        // hybrid: run FTS5 + vector, merge with RRF
        const ftsResults = await db.search(query, normalizedProject);

        if (await db.isVectorSearchEnabled()) {
          const embeddingService = getEmbeddingService();
          const queryEmbedding = await embeddingService.embed(query);
          if (queryEmbedding) {
            const vecResults = await db.vectorSearch(queryEmbedding, normalizedProject, 20);
            const ftsIds = new Set(ftsResults.map(o => o.id));
            // FTS5-matched results always pass; vector-only results must clear the floor
            observations = mergeWithRRF(ftsResults, vecResults).filter(
              o => ftsIds.has(o.id!) || (o.similarity_score == null || o.similarity_score >= SEARCH_MIN_SCORE)
            );
            searchMethod = 'hybrid (RRF)';
          } else {
            observations = ftsResults;
            searchMethod = 'keyword (embedding unavailable)';
          }
        } else {
          observations = ftsResults;
          searchMethod = 'keyword (vector search unavailable)';
        }
      }

      // Always search prompts (keyword-based, fast)
      const prompts = await db.searchPrompts(query, normalizedProject);

      // Build response sections
      const sections: string[] = [];

      // Session-level results (from semantic strategy)
      if (sessionResults.length > 0) {
        const lines: string[] = [];
        for (const session of sessionResults) {
          const date = new Date(session.started_at);
          const shortId = session.id.substring(0, 8);
          const summaryPreview = session.summary
            ? session.summary.substring(0, 200).replace(/\n/g, ' ')
            : 'No summary';
          lines.push(`[${date.toISOString()}] Session ${shortId} (${session.project})`);
          lines.push(`  ${summaryPreview}`);
          lines.push('');
        }
        sections.push(`Found ${sessionResults.length} semantically similar sessions (${searchMethod}):\n\n${lines.join('\n')}`);
      }

      // Observation results
      if (observations.length > 0) {
        sections.push(`Found ${observations.length} observations (${searchMethod}):\n\n${formatObservations(observations)}`);

        // Enrich top 3 results with related observations
        const topResults = observations.slice(0, 3).filter(o => o.id != null);
        const relatedIds = new Set(observations.map(o => o.id));
        const relatedObs: Observation[] = [];
        const crossProjectObs: Observation[] = [];
        for (const obs of topResults) {
          // Intra-project relations (same_file, followed_by)
          const related = await db.getRelatedObservations(obs.id!, ['same_file', 'followed_by']);
          for (const r of related) {
            if (r.id != null && !relatedIds.has(r.id)) {
              relatedIds.add(r.id);
              relatedObs.push(r);
            }
          }
          // Cross-project relations (cross_project_same_file)
          const crossRelated = await db.getRelatedObservations(obs.id!, ['cross_project_same_file']);
          for (const r of crossRelated) {
            if (r.id != null && !relatedIds.has(r.id)) {
              relatedIds.add(r.id);
              crossProjectObs.push(r);
            }
          }
        }
        if (relatedObs.length > 0) {
          sections.push(`Related observations:\n\n${formatObservations(relatedObs.slice(0, 10))}`);
        }
        if (crossProjectObs.length > 0) {
          sections.push(`Cross-project related observations (same file, different project):\n\n${formatObservations(crossProjectObs.slice(0, 10))}`);
        }
      }

      if (prompts.length > 0) {
        sections.push(`Found ${prompts.length} user prompts matching "${query}":\n\n${formatPrompts(prompts)}`);
      }

      if (sections.length === 0) {
        const floorNote =
          strategy === 'semantic' || (strategy === 'hybrid' && searchMethod === 'hybrid (RRF)')
            ? ` Results may exist but scored below the relevance threshold (${SEARCH_MIN_SCORE}). Try a more specific query or use a keyword search.`
            : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No observations found matching "${query}" (${searchMethod}).${floorNote}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: sections.join('\n\n'),
          },
        ],
      };
    }
  );

  server.tool(
    'context_list',
    'List recent Claude Code session activity for a project, grouped by session with summaries and importance indicators. Use to understand what was done recently or get context on recent changes.',
    {
      project: z
        .string()
        .describe('Project path to list observations for'),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of sessions to return (default: 10)'),
    },
    async ({ project, limit }) => {
      if (isProxy) {
        return proxyToolCall('context_list', { project: np(project), limit }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project) ?? project;
      const sessionsWithObs = await db.getRecentSessionsWithObservations(normalizedProject, limit);

      if (sessionsWithObs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No sessions found for ${project}.` }],
        };
      }

      const lines: string[] = [];

      for (const { session, observations } of sessionsWithObs) {
        const shortId = session.id.substring(0, 8);
        const date = formatShortDate(session.started_at);
        const duration = computeSessionDuration(session);
        const narrative = extractSessionNarrative(session.summary);
        const counts = countByImportance(observations);

        // Session header
        const header = narrative
          ? `Session ${shortId} (${date}, ${duration}) - ${narrative}`
          : `Session ${shortId} (${date}, ${duration})`;
        lines.push(header);

        // Extended narrative for multi-beat sessions (top-3 scored messages)
        if (session.summary_extended) {
          const beats = session.summary_extended.split('\n\n---\n\n');
          for (const beat of beats) {
            const preview = beat.replace(/\n+/g, ' ').substring(0, 200);
            lines.push(`  [NARRATIVE] ${preview}`);
          }
        }

        // High-importance observations inline
        const highObs = observations.filter(o => o.importance === 'high' && o.tool_name !== 'Conversation');
        for (const obs of highObs.slice(0, 5)) {
          const fileInfo = obs.files_touched.length > 0
            ? ` (${obs.files_touched.map(f => f.split('/').pop()).join(', ')})`
            : '';
          lines.push(`  [HIGH] ${obs.tool_name}: ${obs.summary.substring(0, 80)}${fileInfo}`);
        }
        if (highObs.length > 5) {
          lines.push(`  ... +${highObs.length - 5} more high-importance`);
        }

        // Conversation insights
        const insights = observations.filter(o => o.tool_name === 'Conversation');
        for (const ins of insights.slice(0, 3)) {
          lines.push(`  [INSIGHT] ${ins.summary.substring(0, 80)}`);
        }

        // Collapse the rest
        const remaining = observations.length - highObs.slice(0, 5).length - insights.slice(0, 3).length;
        if (remaining > 0) {
          lines.push(`  ... ${remaining} more (${counts.medium} medium, ${counts.low} low)`);
        }

        lines.push('');
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Recent sessions for ${project}:\n\n${lines.join('\n')}`,
          },
        ],
      };
    }
  );

  server.tool(
    'context_stats',
    'Show context-manager statistics including observation counts, token usage, and importance distribution.',
    {
      project: z
        .string()
        .optional()
        .describe(
          'Project path to get stats for. Omit for all projects.'
        ),
    },
    async ({ project }) => {
      if (isProxy) {
        return proxyToolCall('context_stats', { project: np(project) }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);
      const stats = await db.getStats(normalizedProject);

      // Gather vector search stats
      const vecEnabled = await db.isVectorSearchEnabled();
      const embeddingService = getEmbeddingService();
      const vectorStats: VectorStats = {
        vector_search_enabled: vecEnabled,
        embedded_count: 0,
        unembedded_count: 0,
        embedding_status: vecEnabled ? embeddingService.getStatus().status : 'n/a',
      };
      if (vecEnabled) {
        vectorStats.unembedded_count = db.countUnembedded(normalizedProject);
        vectorStats.embedded_count = stats.total_observations - vectorStats.unembedded_count;
      }

      // Session embedding stats
      let sessionEmbeddingStats: { embedded: number; pending: number } | undefined;
      if (vecEnabled) {
        const pendingSessions = await db.countUnembeddedSessions(normalizedProject);
        const totalCompleteSessions = await db.countSessions(normalizedProject, 'complete');
        sessionEmbeddingStats = {
          embedded: totalCompleteSessions - pendingSessions,
          pending: pendingSessions,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatStats(stats, normalizedProject, vectorStats, sessionEmbeddingStats),
          },
        ],
      };
    }
  );

  server.tool(
    'context_export',
    'Export high-importance observations to auto-memory topic file. Use at end of significant work sessions or when asked to save context.',
    {
      project: z.string().describe('Project path to export observations for'),
      dry_run: z
        .boolean()
        .optional()
        .default(false)
        .describe('Preview what would be exported without writing files'),
    },
    async ({ project, dry_run }) => {
      if (isProxy) {
        return proxyToolCall('context_export', { project: np(project), dry_run }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project) ?? project;
      const observations = await db.getUnexportedHighImportance(normalizedProject);

      if (observations.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No unexported high-importance observations found.',
            },
          ],
        };
      }

      if (dry_run) {
        const formatted = formatObservationsForMemory(observations);
        const targetDir = resolveMemoryDir(normalizedProject);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Would export ${observations.length} observations to ${targetDir}/context-manager-activity.md:\n\n${formatted}`,
            },
          ],
        };
      }

      const result = await exportToAutoMemory(db, normalizedProject);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Exported ${result.exported} observations to auto-memory.${result.filePath ? `\nTopic file: ${result.filePath}` : ''}`,
          },
        ],
      };
    }
  );

  server.tool(
    'context_vacuum',
    'Clean up old observations and optimize the context-manager database. Use for maintenance.',
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe(
          'Delete observations older than this many days (1-3650). Omit to only clean orphaned sessions and optimize.'
        ),
      stale_session_hours: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Mark active sessions with no activity older than this many hours as complete (default: 2). Uses last_checkpoint_at when available, falls back to started_at.'
        ),
    },
    async ({ days, stale_session_hours }) => {
      if (isProxy) {
        return proxyToolCall('context_vacuum', { days, stale_session_hours }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const result = await db.vacuum(days, stale_session_hours);

      const lines: string[] = [];
      if (result.closedStaleSessions > 0) {
        lines.push(`Closed ${result.closedStaleSessions} stale active session(s) with no Stop hook.`);
      }
      if (days) {
        lines.push(`Deleted ${result.observations} observations older than ${days} days.`);
      }
      if (result.compacted > 0) {
        lines.push(
          `Compacted ${result.compacted_originals} observations into ${result.compacted} summaries.`
        );
      }
      if (result.sessions > 0) {
        lines.push(`Cleaned up ${result.sessions} orphaned sessions.`);
      }
      lines.push('Database optimized.');

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.join('\n'),
          },
        ],
      };
    }
  );

  server.tool(
    'context_prune',
    'Targeted pruning of observations by tool name, importance, and/or age. Safer than context_vacuum: filters precisely rather than deleting by age alone. Use dry_run=true first to preview what would be deleted. At least one filter is required.',
    {
      tool_name: z
        .string()
        .optional()
        .describe('Delete observations from this tool (e.g., "Bash", "Read", "Grep")'),
      importance: z
        .enum(['high', 'medium', 'low'])
        .optional()
        .describe('Delete observations at this importance level (e.g., "low")'),
      older_than_days: z
        .number()
        .optional()
        .describe('Only delete observations older than this many days'),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          'Preview count and sample observations without deleting. Default: false. Always run dry_run=true first.'
        ),
    },
    async ({ tool_name, importance, older_than_days, dry_run }) => {
      if (!tool_name && !importance && older_than_days === undefined) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'At least one filter (tool_name, importance, or older_than_days) is required.',
            },
          ],
        };
      }

      if (isProxy) {
        return proxyToolCall('context_prune', { tool_name, importance, older_than_days, dry_run }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const result = await db.prune({
        toolName: tool_name,
        importance: importance as ImportanceLevel | undefined,
        olderThanDays: older_than_days,
        dryRun: dry_run,
      });

      const filters = [
        tool_name && `tool="${tool_name}"`,
        importance && `importance="${importance}"`,
        older_than_days !== undefined && `older_than=${older_than_days}d`,
      ]
        .filter(Boolean)
        .join(', ');

      if (dry_run) {
        const sampleLines = result.preview?.map(p => `  * ${p}`).join('\n') ?? '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `DRY RUN - would delete ${result.deleted} observations [${filters}].\nSample (up to 5):\n${sampleLines}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Deleted ${result.deleted} observations [${filters}].`,
          },
        ],
      };
    }
  );

  server.tool(
    'context_semantic_search',
    'Search past Claude Code sessions using semantic similarity. Finds conceptually related work even when exact keywords differ. Searches session-level embeddings (enriched with user prompts + actions + outcomes) by default, with fallback to observation-level.',
    {
      query: z.string().describe('Natural language query describing what you are looking for'),
      project: z
        .string()
        .optional()
        .describe('Project path to scope search. Omit to search all projects.'),
      top_k: z
        .number()
        .optional()
        .default(10)
        .describe('Maximum number of results to return (default: 10)'),
      scope: z
        .enum(['sessions', 'observations'])
        .optional()
        .default('sessions')
        .describe('Search scope: "sessions" (default, enriched) or "observations" (legacy, per-tool)'),
    },
    async ({ query, project, top_k, scope }) => {
      if (isProxy) {
        return proxyToolCall('context_semantic_search', { query, project: np(project), top_k, scope }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);

      if (!await db.isVectorSearchEnabled()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Vector search is not available (sqlite-vec extension not loaded). FTS5 keyword search via context_search is still available.',
            },
          ],
        };
      }

      const embeddingService = getEmbeddingService();
      const queryEmbedding = await embeddingService.embed(query);

      if (!queryEmbedding) {
        const { status, error } = embeddingService.getStatus();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Embedding model not available (status: ${status}).${error ? ` ${error}` : ''}\n\nFTS5 keyword search via context_search is still available.`,
            },
          ],
        };
      }

      if (scope === 'sessions') {
        // Session-level semantic search (enriched text)
        const sessions = await db.vectorSearchSessions(queryEmbedding, normalizedProject, top_k);

        if (sessions.length > 0) {
          const lines: string[] = [];
          for (const session of sessions) {
            const date = new Date(session.started_at);
            const shortId = session.id.substring(0, 8);
            const summaryPreview = session.summary
              ? session.summary.substring(0, 200).replace(/\n/g, ' ')
              : 'No summary';
            lines.push(`[${date.toISOString()}] Session ${shortId} (${session.project})`);
            lines.push(`  ${summaryPreview}`);

            // Fetch key observations for this session
            const obs = await db.getSessionObservations(session.id);
            const highValue = obs
              .filter(o => o.importance === 'high')
              .slice(0, 3);
            for (const o of highValue) {
              const fileInfo = o.files_touched.length > 0
                ? ` (${o.files_touched.map(f => f.split('/').pop()).join(', ')})`
                : '';
              lines.push(`    - ${o.tool_name}: ${o.summary.substring(0, 80)}${fileInfo}`);
            }
            lines.push('');
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Found ${sessions.length} semantically similar sessions for "${query}":\n\n${lines.join('\n')}`,
              },
            ],
          };
        }

        // No session results, fall through to observation search
        const observations = await db.vectorSearch(queryEmbedding, normalizedProject, top_k);
        return {
          content: [
            {
              type: 'text' as const,
              text: observations.length > 0
                ? `No session embeddings found, falling back to observation search.\nFound ${observations.length} semantically similar observations for "${query}":\n\n${formatObservations(observations)}`
                : `No embedded sessions or observations found${normalizedProject ? ` for ${normalizedProject}` : ''}. Run context_embed first to generate embeddings.`,
            },
          ],
        };
      }

      // Legacy observation-level search
      const observations = await db.vectorSearch(queryEmbedding, normalizedProject, top_k);
      return {
        content: [
          {
            type: 'text' as const,
            text: observations.length > 0
              ? `Found ${observations.length} semantically similar observations for "${query}":\n\n${formatObservations(observations)}`
              : `No embedded observations found${normalizedProject ? ` for ${normalizedProject}` : ''}. Run context_embed first to generate embeddings.`,
          },
        ],
      };
    }
  );

  server.tool(
    'context_embed',
    'Generate vector embeddings for observations that are missing them. Embeddings enable semantic search via context_semantic_search. First run auto-installs dependencies (~265MB) and downloads the model (~80MB). This may take a few minutes.',
    {
      project: z
        .string()
        .optional()
        .describe('Project path to scope embedding. Omit to embed all projects.'),
      batch_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(50)
        .describe('Number of observations to embed per batch (default: 50, max: 500)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(500)
        .describe('Maximum total observations to embed in this call (default: 500, max: 10000)'),
    },
    async ({ project, batch_size, limit }) => {
      if (isProxy) {
        return proxyToolCall('context_embed', { project: np(project), batch_size, limit }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);

      if (!await db.isVectorSearchEnabled()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Vector search is not available (sqlite-vec extension not loaded). Cannot generate embeddings.',
            },
          ],
        };
      }

      const embeddingService = getEmbeddingService();
      const loaded = await embeddingService.load();

      if (!loaded) {
        const { error } = embeddingService.getStatus();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to load embedding model.${error ? ` ${error}` : ''}`,
            },
          ],
        };
      }

      const unembedded = await db.getUnembeddedObservations(limit, normalizedProject);

      if (unembedded.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `All observations${normalizedProject ? ` for ${normalizedProject}` : ''} already have embeddings.`,
            },
          ],
        };
      }

      let embedded = 0;
      let errors = 0;

      // Process in batches
      for (let i = 0; i < unembedded.length; i += batch_size) {
        const batch = unembedded.slice(i, i + batch_size);

        // Build text for embedding: summary + files
        const texts = batch.map(obs => {
          const parts = [obs.summary];
          if (obs.files_touched.length > 0) {
            parts.push(obs.files_touched.join(', '));
          }
          return parts.join(' | ');
        });

        const embeddings = await embeddingService.embedBatch(texts);
        if (!embeddings) {
          errors += batch.length;
          continue;
        }

        for (let j = 0; j < batch.length; j++) {
          const obs = batch[j];
          const emb = embeddings[j];
          if (!obs?.id || !emb) { errors++; continue; }
          try {
            await db.saveEmbedding(obs.id, emb);
            embedded++;
          } catch {
            errors++;
          }
        }
      }

      // --- Session Embeddings ---
      let sessionEmbedded = 0;
      let sessionErrors = 0;

      const unembeddedSessions = await db.getUnembeddedSessions(limit, normalizedProject);

      for (const session of unembeddedSessions) {
        try {
          const prompts = await db.getSessionPrompts(session.id);
          const observations = await db.getSessionObservations(session.id);

          const enrichedText = buildSessionEmbeddingText(prompts, observations, session.summary);
          if (enrichedText.length < 20) {
            // Skip sessions with too little content
            continue;
          }

          const sessionEmb = await embeddingService.embed(enrichedText);
          if (sessionEmb) {
            await db.saveSessionEmbedding(session.id, sessionEmb, enrichedText);
            sessionEmbedded++;
          } else {
            sessionErrors++;
          }
        } catch {
          sessionErrors++;
        }
      }

      const lines: string[] = [];
      const { didAutoInstall } = embeddingService.getStatus();
      if (didAutoInstall) {
        lines.push('Auto-installed @huggingface/transformers + onnxruntime-node.');
      }
      lines.push(`Embedded ${embedded} observations.`);
      if (errors > 0) {
        lines.push(`${errors} observations failed to embed.`);
      }
      if (sessionEmbedded > 0) {
        lines.push(`Embedded ${sessionEmbedded} sessions (enriched text).`);
      }
      if (sessionErrors > 0) {
        lines.push(`${sessionErrors} sessions failed to embed.`);
      }
      const remaining = unembedded.length - embedded;
      if (remaining > 0 && unembedded.length === limit) {
        lines.push(`More observations may remain - run again to continue.`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: lines.join('\n'),
          },
        ],
      };
    }
  );

  // --- Memory Audit & Consolidation Tools ---

  server.tool(
    'context_memory_audit',
    'Scan ~/.claude/projects/ for memory directories related to a project path. Identifies orphaned child directories whose memories become invisible when the launch directory changes to a parent path.',
    {
      project: z
        .string()
        .describe(
          'The project path to audit (e.g., "/Users/you/Projects/MyProject"). All child directories under this path will be scanned for orphaned memory files.'
        ),
    },
    async ({ project }) => {
      if (isProxy) {
        return proxyToolCall('context_memory_audit', { project: np(project) }, remoteUrl, remoteToken);
      }

      try {
        const normalizedProject = np(project) ?? project;
        const report = auditMemoryDirectories(normalizedProject);
        return {
          content: [
            {
              type: 'text' as const,
              text: formatAuditReport(report),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error auditing memory directories: ${String(error)}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    'context_memory_consolidate',
    'Migrate memory files from child project paths to a parent path, then rebuild the parent MEMORY.md index. Run context_memory_audit first to preview what will be migrated.',
    {
      project: z
        .string()
        .describe(
          'The parent project path to consolidate into (e.g., "/Users/you/Projects/MyProject").'
        ),
      dry_run: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Preview what would happen without making changes (default: true). Set to false to actually migrate files.'
        ),
      include_stale: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include project-type memories older than 90 days (default: false). These are normally skipped as likely stale session notes.'
        ),
    },
    async ({ project, dry_run, include_stale }) => {
      if (isProxy) {
        return proxyToolCall('context_memory_consolidate', { project: np(project), dry_run, include_stale }, remoteUrl, remoteToken);
      }

      try {
        const normalizedProject = np(project) ?? project;
        const report = consolidateMemories(normalizedProject, dry_run, include_stale);
        return {
          content: [
            {
              type: 'text' as const,
              text: formatConsolidationReport(report),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error consolidating memory files: ${String(error)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}
