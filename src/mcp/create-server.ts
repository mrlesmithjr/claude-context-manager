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
import { existsSync } from 'fs';
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
import type { Decision, ImportanceLevel, Observation, ObservationTag, ProjectEntry, Session, Stats, UserPrompt } from '../storage/interface.js';
import {
  computeSessionDuration,
  extractSessionNarrative,
  countByImportance,
  formatShortDate,
} from '../utils/session-format.js';
import { classifyQuery, type QueryStrategy } from '../utils/classify.js';
import { classifyTemporalIntent, type TemporalMode } from '../utils/temporal.js';
import { correctTokens } from '../utils/correct-tokens.js';
import { normalizePath, type PathPrefixEntry } from '../utils/path-map.js';
import { buildReflection, formatReflection } from '../utils/reflect.js';
import { getCurrentBranch } from '../utils/git.js';

// Minimum cosine similarity score for semantic/hybrid search results.
// Results below this threshold are suppressed to avoid returning low-signal noise.
// Applies to semantic path only. FTS5 (keyword) results are exact matches and always pass.
// Override via CONTEXT_SEARCH_MIN_SCORE env var.
const SEARCH_MIN_SCORE = parseFloat(process.env.CONTEXT_SEARCH_MIN_SCORE ?? '0.25');

// Allowed tag values for context_add — must match ObservationTag union in storage/interface.ts.
// Developer tags are also inferred automatically by hook capture (TAG_FILE_RULES / TAG_BASH_RULES
// in capture/processor.ts). Personal ops tags are for manual context_add writes only.
// Typed as Set<ObservationTag> so a compile error fires if the union gains a new member.
const ALLOWED_OBSERVATION_TAGS = new Set<ObservationTag>([
  // Developer / code tags
  'auth', 'database', 'testing', 'infra', 'config',
  'frontend', 'api', 'git', 'build', 'deps', 'error',
  // Personal ops tags
  'home', 'lawn', 'finance', 'health', 'travel', 'planning', 'decision', 'personal',
]);

// Version injected by esbuild; falls back for non-bundled environments (e.g., ts-node, vitest)
declare const PLUGIN_VERSION: string;

export interface ServerOptions {
  remoteUrl?: string;
  remoteToken?: string;
  pathMap?: PathPrefixEntry[];
  version?: string;
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
  sessionEmbeddingStats?: { embedded: number; pending: number },
  version?: string
): string {
  const lines: string[] = [];

  lines.push('Context Manager Statistics');
  const resolvedVersion = version ?? (typeof PLUGIN_VERSION !== 'undefined' ? PLUGIN_VERSION : 'unknown');
  lines.push(`Version: ${resolvedVersion}`);
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
  const budgetPct = stats.token_budget > 0
    ? Math.round((stats.budget_fill_tokens / stats.token_budget) * 100)
    : 0;
  lines.push(
    `Budget Fill: ${stats.budget_fill_tokens.toLocaleString()} / ${stats.token_budget.toLocaleString()} tokens (${budgetPct}%)`
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

  const hasCompactionData = stats.compacted_count > 0 || stats.compacted_last_24h > 0 || stats.next_compaction_eligible > 0 || stats.sessions_gc_last_24h > 0;
  if (hasCompactionData) {
    lines.push('');
    lines.push('=== Compaction ===');
    if (stats.compacted_count > 0) {
      lines.push(
        `  Total compacted: ${stats.compacted_count} groups (from ${stats.compacted_original_count} originals)`
      );
    }
    if (stats.compacted_last_24h > 0) {
      lines.push(`  Compacted last 24h: ${stats.compacted_last_24h} groups`);
    }
    if (stats.sessions_gc_last_24h > 0) {
      lines.push(`  Sessions GC'd last 24h: ${stats.sessions_gc_last_24h}`);
    }
    if (stats.next_compaction_eligible > 0) {
      lines.push(`  Eligible for next compaction: ${stats.next_compaction_eligible} observations`);
    }
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
 * Format lesson observations for tool output.
 * Each lesson is rendered as a compact multi-line block showing the type, tool, summary,
 * importance score, and session ID.
 */
function formatLessons(lessons: Observation[]): string {
  if (lessons.length === 0) {
    return 'No lessons found for this project.';
  }

  const lines: string[] = [];
  for (const obs of lessons) {
    const date = new Date(obs.created_at);
    const datePart = date.toISOString().substring(0, 10);
    const timePart = date.toISOString().substring(11, 16);
    const lessonLabel = obs.lesson_type ?? 'error';
    const shortSessionId = obs.session_id.substring(0, 6);
    lines.push(`[${datePart} ${timePart}] ${lessonLabel} | ${obs.tool_name}`);
    lines.push(obs.summary);
    lines.push(`importance: ${obs.importance_score.toFixed(2)} | session: ${shortSessionId}...`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Format a list of decisions for tool output.
 * Each decision renders as a numbered block with date, decision text, and optional context.
 */
function formatDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return 'No decisions recorded for this project yet.';
  }

  const lines: string[] = [];
  for (const d of decisions) {
    const date = new Date(d.captured_at);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const numLabel = d.decision_number != null ? `#${d.decision_number}` : '#?';
    lines.push(`${numLabel} [${dateStr}] ${d.decision_text}`);
    if (d.context) {
      lines.push(`    Context: ${d.context}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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

/**
 * Apply temporal ordering/scoring to a list of results in-memory.
 *
 * Used for result sets that bypass the sql.ts search() path (semantic vector
 * results, tag-filtered results) so they receive the same adjustments.
 *
 * current:    multiply importance_score by a recency factor, re-sort descending
 * historical: sort ascending by the date field (oldest first)
 * neutral:    return items unchanged
 *
 * The recency factor thresholds (applied for 'current' mode):
 *   0-7 days:  1.5x
 *   8-30 days: 1.1x
 *   31-90 days: 0.9x
 *   90+ days:  0.7x
 *
 * Note: importance_score is mutated only on the spread copies produced here;
 * no DB writes occur.
 */
function recencyFactorForDate(dateStr: string): number {
  const ageDays = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7)  return 1.5;
  if (ageDays <= 30) return 1.1;
  if (ageDays <= 90) return 0.9;
  return 0.7;
}

// Overload for items that carry importance_score (Observation and similar)
function applyTemporalAdjustment<T extends { importance_score: number; created_at?: string; started_at?: string }>(
  items: T[],
  mode: TemporalMode,
  dateField: 'created_at' | 'started_at',
): T[];
// Overload for items without importance_score (Session); only date-ordering is applied
function applyTemporalAdjustment<T extends { created_at?: string; started_at?: string }>(
  items: T[],
  mode: TemporalMode,
  dateField: 'created_at' | 'started_at',
): T[];
function applyTemporalAdjustment<T extends { importance_score?: number; created_at?: string; started_at?: string }>(
  items: T[],
  mode: TemporalMode,
  dateField: 'created_at' | 'started_at',
): T[] {
  if (mode === 'current') {
    if (items.length > 0 && 'importance_score' in items[0]!) {
      // Score-carrying items: apply recency factor and re-sort descending
      return (items as Array<T & { importance_score: number }>)
        .map(item => ({
          ...item,
          importance_score: (item.importance_score ?? 0.5) * recencyFactorForDate((item[dateField] as string) ?? new Date().toISOString()),
        }))
        .sort((a, b) => b.importance_score - a.importance_score) as T[];
    }
    // Items without importance_score (e.g. Session): sort most-recent first by date field
    return [...items].sort((a, b) =>
      new Date((b[dateField] as string) ?? 0).getTime() - new Date((a[dateField] as string) ?? 0).getTime()
    );
  }
  if (mode === 'historical') {
    return [...items].sort((a, b) =>
      new Date((a[dateField] as string) ?? 0).getTime() - new Date((b[dateField] as string) ?? 0).getTime()
    );
  }
  return items;
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
  storage: SQLiteStorage | null,
  options: ServerOptions = {}
): McpServer {
  const { remoteUrl = '', remoteToken = '', pathMap = [], version: optVersion } = options;
  const resolvedVersion = optVersion ?? (typeof PLUGIN_VERSION !== 'undefined' ? PLUGIN_VERSION : 'unknown');
  const isProxy = !!remoteUrl;

  const server = new McpServer(
    {
      name: 'context-manager',
      version: resolvedVersion,
    },
    {
      instructions:
        'Check context_list at session start to load relevant prior context. ' +
        'Use context_search for targeted lookups and context_semantic_search for broader discovery. ' +
        'Use context_prune for targeted cleanup by tool_name, importance, or age. Always run with dry_run=true first to preview. Requires at least one filter to prevent accidental full wipe.',
    },
  );

  // Helper: resolve storage (only valid in local mode; proxy mode passes null and never calls getDb)
  const getDb = (): Promise<SQLiteStorage> => Promise.resolve(storage as SQLiteStorage);

  // Helper: normalize a project path through the configured prefix map
  const np = (p: string | undefined): string | undefined =>
    p !== undefined ? normalizePath(p, pathMap) : undefined;

  // --- Tool Definitions ---

  /**
   * Format a single observation as a compact one-line summary.
   * Format: #<id> [YYYY-MM-DD HH:MM] <tool_name> <first 60 chars of summary>
   */
  function formatObservationCompact(obs: Observation): string {
    const date = new Date(obs.created_at);
    const datePart = date.toISOString().substring(0, 10);
    const timePart = date.toISOString().substring(11, 16);
    const summaryFragment = obs.summary.length > 80
      ? obs.summary.substring(0, 80)
      : obs.summary;
    return `#${obs.id} [${datePart} ${timePart}] ${obs.tool_name} ${summaryFragment}`;
  }

  server.tool(
    'context_search',
    'Search past Claude Code session activity. Automatically routes to the optimal search strategy: keyword (FTS5) for short/specific queries, semantic (vector similarity) for natural language, or hybrid (both merged with Reciprocal Rank Fusion) for mixed queries. Also searches user prompts and enriches results with related observations. Supports tag:X prefix to filter by domain tag. Returns compact one-line summaries by default; pass compact=false for full text. Automatically detects temporal intent: queries with "current", "latest", or "recent" boost recent results; queries with "history", "previously", or "timeline" return results in chronological order.',
    {
      query: z.string().describe('Search query. Supports tag:X prefix to filter by domain tag (e.g. "tag:auth", "tag:finance budget"). Developer tags: auth, database, testing, infra, config, frontend, api, git, build, deps. Personal ops tags: home, lawn, finance, health, travel, planning, decision, personal.'),
      project: z
        .string()
        .optional()
        .describe(
          'Project path to scope search. Omit to search all projects.'
        ),
      compact: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'When true (default), each result is one line: #<id> [date time] tool summary. Pass compact=false to get full observation text. Use context_get with the returned IDs to fetch full detail for specific results.'
        ),
      branch: z
        .string()
        .optional()
        .describe(
          'Filter by git branch. Omit for soft-rank boost on current branch. Use "*" to return results from all branches without boost.'
        ),
      include_superseded: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Include superseded observations (older contradicted stack preference facts). Default false.'
        ),
      fuzzy: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'When true (default), attempt to correct likely typos in plain query tokens before searching. Tokens with operator prefixes (tag:, lesson:, decision:) are never altered. Set to false to disable correction and search the raw query.'
        ),
    },
    async ({ query, project, compact, branch, include_superseded, fuzzy }) => {
      const useCompact = compact !== false;
      const includeSuperseded = include_superseded === true;

      if (isProxy) {
        return proxyToolCall('context_search', { query, project: np(project), compact: useCompact, branch, include_superseded: includeSuperseded, fuzzy }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);

      // Fuzzy correction pre-pass: attempt to fix typos before routing.
      // Runs before classifyQuery so that the corrected query drives strategy selection.
      let activeQuery = query;
      let fuzzyChanges: Array<{ from: string; to: string }> = [];

      if (fuzzy !== false) {
        const result = correctTokens(activeQuery, (token) =>
          db.findClosestToken(token)
        );
        activeQuery = result.corrected;
        fuzzyChanges = result.changes;
      }

      // Detect the current branch at query time for soft-rank or label display.
      // Only used when branch param is omitted (soft-rank mode).
      const currentBranch = branch === undefined
        ? getCurrentBranch(normalizedProject ?? process.cwd())
        : null;

      // Classify temporal intent before any branch so all paths can apply ordering.
      const temporalMode: TemporalMode = classifyTemporalIntent(activeQuery);

      // Check for lesson: prefix — routes to getLessons() and returns early.
      // If the term after "lesson:" exactly matches a valid lesson_type value,
      // route it to the lessonType filter; otherwise treat it as a summary keyword.
      if (activeQuery.startsWith('lesson:')) {
        const VALID_LESSON_TYPES = new Set(['error', 'build_failure', 'test_failure', 'permission_denied']);
        const lessonRaw = activeQuery.slice('lesson:'.length).trim();
        const isType = VALID_LESSON_TYPES.has(lessonRaw);
        const lessons = await db.getLessons(
          normalizedProject,
          isType ? undefined : (lessonRaw || undefined),  // summary keyword
          isType ? lessonRaw : undefined,                  // lesson_type filter
          20
        );
        const text = formatLessons(lessons);
        return { content: [{ type: 'text' as const, text }] };
      }

      // Check for decision: prefix — routes to searchDecisions() and returns early.
      // This is distinct from the 'decision' tag filter (tag:decision) which searches
      // observations tagged with the 'decision' domain tag.
      if (activeQuery.startsWith('decision:')) {
        const decisionQuery = activeQuery.slice('decision:'.length).trim() || undefined;
        const decisions = await db.searchDecisions(normalizedProject ?? '/', decisionQuery, 20);
        const text = formatDecisions(decisions);
        return { content: [{ type: 'text' as const, text }] };
      }

      // Check for tag: prefix, routes to tag search, optionally combined with keyword
      const { tag, remainingQuery } = parseTagPrefix(activeQuery);
      if (tag) {
        const tagObs = await db.searchByTag(tag, normalizedProject, 50, includeSuperseded);
        // If there's remaining query text, further filter via FTS5
        let results = tagObs;
        if (remainingQuery.length > 0) {
          const ftsResults = await db.search(remainingQuery, { project: normalizedProject, include_superseded: includeSuperseded });
          const ftsIds = new Set(ftsResults.map(o => o.id));
          results = tagObs.filter(o => ftsIds.has(o.id));
        }
        // Apply temporal ordering to tag results the same way as other paths
        results = applyTemporalAdjustment(results, temporalMode, 'created_at');
        // Apply branch filter post-hoc — searchByTag has no branch parameter
        if (branch && branch !== '*') {
          results = results.filter(o => o.branch === branch);
        }
        const label = remainingQuery
          ? `tag:${tag} + keyword "${remainingQuery}"`
          : `tag:${tag}`;
        const modeLabel = useCompact ? 'compact' : 'full';
        const temporalLabel = temporalMode !== 'neutral' ? ` | temporal: ${temporalMode}` : '';
        const tagBranchLabel = branch && branch !== '*'
          ? ` | branch: ${branch}`
          : branch === '*'
            ? ' | branch: * (all)'
            : '';
        const tagSupersededLabel = includeSuperseded ? ' | +superseded' : '';
        const formattedResults = useCompact
          ? results.map(o => formatObservationCompact(o)).join('\n')
          : formatObservations(results);
        const text = results.length > 0
          ? `[search: ${label}${temporalLabel}${tagBranchLabel}${tagSupersededLabel} | ${modeLabel}] ${results.length} results\n\n${formattedResults}`
          : `No observations found for ${label}.`;
        return { content: [{ type: 'text' as const, text }] };
      }

      const strategy: QueryStrategy = classifyQuery(activeQuery);

      let observations: Observation[] = [];
      let searchMethod = '';
      let sessionResults: Session[] = [];

      // Pass branch to search for exact filtering when branch param was provided.
      // When branch is undefined (soft-rank mode), omit it from searchOptions so
      // search() returns all branches and we apply the 1.2x boost after.
      const searchOptions = {
        project: normalizedProject,
        temporalMode,
        include_superseded: includeSuperseded,
        ...(branch !== undefined ? { branch } : {}),
      };

      if (strategy === 'keyword') {
        observations = await db.search(activeQuery, searchOptions);
        searchMethod = 'keyword';
      } else if (strategy === 'semantic') {
        // Try semantic search; fall back to keyword if embeddings unavailable
        if (await db.isVectorSearchEnabled()) {
          const embeddingService = getEmbeddingService();
          const queryEmbedding = await embeddingService.embed(activeQuery);
          if (queryEmbedding) {
            // Try session-level first (enriched, higher quality)
            const rawSessions = await db.vectorSearchSessions(queryEmbedding, normalizedProject, 10);
            const filteredSessions = rawSessions.filter(
              s => s.similarity_score == null || s.similarity_score >= SEARCH_MIN_SCORE
            );
            // Apply temporal ordering; use started_at as the date field for sessions
            sessionResults = applyTemporalAdjustment(filteredSessions, temporalMode, 'started_at');
            if (sessionResults.length === 0) {
              const rawObs = await db.vectorSearch(queryEmbedding, normalizedProject, 20);
              const filteredObs = rawObs.filter(
                o => o.similarity_score == null || o.similarity_score >= SEARCH_MIN_SCORE
              );
              // Apply temporal ordering to observation-level fallback
              observations = applyTemporalAdjustment(filteredObs, temporalMode, 'created_at');
              // Enforce branch filter — vectorSearch has no branch param
              if (branch !== undefined && branch !== '*') {
                observations = observations.filter(o => o.branch === branch);
              }
              // Enforce superseded filter on vector results (vectorSearch has no superseded param)
              if (!includeSuperseded) {
                observations = observations.filter(o => o.superseded_by == null);
              }
            }
            searchMethod = 'semantic';
          } else {
            observations = await db.search(activeQuery, searchOptions);
            searchMethod = 'keyword (embedding unavailable)';
          }
        } else {
          observations = await db.search(activeQuery, searchOptions);
          searchMethod = 'keyword (vector search unavailable)';
        }
      } else {
        // hybrid: run FTS5 + vector, merge with RRF
        const ftsResults = await db.search(activeQuery, searchOptions);

        if (await db.isVectorSearchEnabled()) {
          const embeddingService = getEmbeddingService();
          const queryEmbedding = await embeddingService.embed(activeQuery);
          if (queryEmbedding) {
            const vecResults = await db.vectorSearch(queryEmbedding, normalizedProject, 20);
            const ftsIds = new Set(ftsResults.map(o => o.id));
            // FTS5-matched results always pass; vector-only results must clear the floor
            observations = mergeWithRRF(ftsResults, vecResults).filter(
              o => ftsIds.has(o.id!) || (o.similarity_score == null || o.similarity_score >= SEARCH_MIN_SCORE)
            );
            // Enforce branch filter on vector component — vectorSearch has no branch param
            if (branch !== undefined && branch !== '*') {
              observations = observations.filter(o => o.branch === branch);
            }
            // Enforce superseded filter on vector component — vectorSearch has no superseded param
            if (!includeSuperseded) {
              observations = observations.filter(o => o.superseded_by == null);
            }
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
      const prompts = await db.searchPrompts(activeQuery, normalizedProject);

      // Soft-rank: when branch was omitted (undefined), boost results on the current branch.
      // Only applies when: branch param omitted, currentBranch is non-null, temporal mode is
      // neutral (stacking with temporal adjustment would produce conflicting signals).
      if (branch === undefined && currentBranch !== null && temporalMode === 'neutral' && observations.length > 0) {
        observations = observations
          .map(o => o.branch === currentBranch
            ? { ...o, importance_score: Math.min(1.0, Math.round(o.importance_score * 1.2 * 100) / 100) }
            : o
          )
          .sort((a, b) => b.importance_score - a.importance_score);
      }

      // Build response sections
      const sections: string[] = [];
      const modeLabel = useCompact ? 'compact' : 'full';

      // When fuzzy correction applied changes, prepend a correction notice line.
      // This is inserted as the first section so it appears above all results.
      if (fuzzyChanges.length > 0) {
        const correctionParts = fuzzyChanges.map(c => `"${c.from}" -> "${c.to}"`).join(', ');
        sections.push(`[corrected: ${correctionParts}]`);
      }
      // Append temporal label to headers only when the mode is non-neutral
      const temporalLabel = temporalMode !== 'neutral' ? ` | temporal: ${temporalMode}` : '';
      // Append branch label when branch filtering is explicitly active
      const branchLabel = branch && branch !== '*'
        ? ` | branch: ${branch}`
        : branch === '*'
          ? ' | branch: * (all)'
          : '';
      // Append superseded label when caller requested superseded results
      const supersededLabel = includeSuperseded ? ' | +superseded' : '';

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
        sections.push(`[search: ${searchMethod}${temporalLabel}${branchLabel}${supersededLabel} | ${modeLabel}] ${sessionResults.length} sessions\n\n${lines.join('\n')}`);
      }

      // Observation results
      if (observations.length > 0) {
        const formattedObs = useCompact
          ? observations.map(o => formatObservationCompact(o)).join('\n')
          : formatObservations(observations);
        sections.push(`[search: ${searchMethod}${temporalLabel}${branchLabel}${supersededLabel} | ${modeLabel}] ${observations.length} results\n\n${formattedObs}`);

        if (!useCompact) {
          // Enrich top 3 results with related observations (full mode only)
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
      }

      if (prompts.length > 0) {
        sections.push(`Found ${prompts.length} user prompts matching "${activeQuery}":\n\n${formatPrompts(prompts)}`);
      }

      if (sections.length === 0 || (sections.length === 1 && fuzzyChanges.length > 0)) {
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
    'context_get',
    'Fetch full detail for specific observations by ID. Use after context_search to read the complete content of results you want to examine. Pass the IDs shown in compact search output (e.g. #142 -> id 142).',
    {
      ids: z.array(z.number().int().positive()).min(1).max(20).describe('Observation IDs from a prior context_search call (max 20)'),
    },
    async ({ ids }) => {
      if (isProxy) {
        return proxyToolCall('context_get', { ids }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const observations = await db.getObservationsByIds(ids);

      // Report any missing IDs
      const foundIds = new Set(observations.map(o => o.id));
      const missingIds = ids.filter(id => !foundIds.has(id));

      const lines: string[] = [];

      for (const obs of observations) {
        const date = new Date(obs.created_at);
        const datePart = date.toISOString().substring(0, 10);
        const timePart = date.toISOString().substring(11, 16);
        const tagsStr = obs.tags && obs.tags.length > 0 ? `[${obs.tags.join(', ')}]` : '[]';
        const shortSessionId = obs.session_id.substring(0, 8);

        lines.push(`#${obs.id} [${datePart} ${timePart}] importance: ${obs.importance_score.toFixed(2)} tags: ${tagsStr}`);

        const fileStr = obs.files_touched.length > 0
          ? obs.files_touched.map(f => f.split('/').pop()).join(', ')
          : '(none)';
        lines.push(`Tool: ${obs.tool_name} | File: ${fileStr} | Session: ${shortSessionId}`);
        lines.push(`Summary: ${obs.summary}`);

        // Fetch related observations with relationship types
        const relRows = await db.getRelatedObservationRefs(obs.id!);
        if (relRows.length > 0) {
          const relatedParts = relRows.map(r => `#${r.id} (${r.relationship})`);
          lines.push(`Related: ${relatedParts.join(', ')}`);
        }

        lines.push('');
      }

      if (missingIds.length > 0) {
        for (const id of missingIds) {
          lines.push(`ID ${id} not found`);
        }
      }

      const text = lines.join('\n').trimEnd();
      return {
        content: [{ type: 'text' as const, text: text || 'No observations found for the given IDs.' }],
      };
    }
  );

  server.tool(
    'context_timeline',
    'Show session context around specific observation IDs. Returns the matched observations plus neighboring observations from the same session, giving chronological context for what was happening around each match. Use after context_search to understand what led up to and followed a result.',
    {
      ids: z.array(z.number().int().positive()).min(1).max(10).describe('Observation IDs from a prior context_search call (max 10)'),
      window: z.number().int().min(1).max(10).optional().default(3).describe('Number of observations to include on each side of each match (default: 3)'),
    },
    async ({ ids, window: windowSize }) => {
      const effectiveWindow = windowSize ?? 3;

      if (isProxy) {
        return proxyToolCall('context_timeline', { ids, window: effectiveWindow }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const lines: string[] = [];

      // Deduplicate incoming IDs before processing to avoid redundant neighbor queries
      const uniqueIds = [...new Set(ids)];

      // Track globally rendered observation IDs to suppress duplicates when windows overlap
      const renderedIds = new Set<number>();

      for (const id of uniqueIds) {
        const result = await db.getObservationNeighbors(id, effectiveWindow);

        if (!result) {
          lines.push(`ID ${id} not found`);
          lines.push('');
          continue;
        }

        const { before, target, after } = result;

        lines.push(`=== Context around #${id} ===`);

        for (const obs of before) {
          if (!renderedIds.has(obs.id!)) {
            const date = new Date(obs.created_at);
            const timePart = date.toISOString().substring(11, 16);
            const fragment = obs.summary.length > 80 ? obs.summary.substring(0, 80) : obs.summary;
            lines.push(`    #${obs.id} [${timePart}] ${obs.tool_name} ${fragment}`);
            renderedIds.add(obs.id!);
          }
        }

        // Target observation (highlighted)
        {
          const date = new Date(target.created_at);
          const timePart = date.toISOString().substring(11, 16);
          const fragment = target.summary.length > 80 ? target.summary.substring(0, 80) : target.summary;
          lines.push(`>>> #${target.id} [${timePart}] ${target.tool_name} ${fragment}  [MATCH]`);
          renderedIds.add(target.id!);
        }

        for (const obs of after) {
          if (!renderedIds.has(obs.id!)) {
            const date = new Date(obs.created_at);
            const timePart = date.toISOString().substring(11, 16);
            const fragment = obs.summary.length > 80 ? obs.summary.substring(0, 80) : obs.summary;
            lines.push(`    #${obs.id} [${timePart}] ${obs.tool_name} ${fragment}`);
            renderedIds.add(obs.id!);
          }
        }

        lines.push('');
      }

      const text = lines.join('\n').trimEnd();
      return {
        content: [{ type: 'text' as const, text: text || 'No timeline data found for the given IDs.' }],
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

      const parsedBudget = parseInt(process.env.CONTEXT_MANAGER_TOKEN_BUDGET || '4000', 10);
      const TOKEN_BUDGET_LIST = Number.isFinite(parsedBudget) && parsedBudget > 0 && parsedBudget <= 100000 ? parsedBudget : 4000;
      const effectiveBudget = Math.floor(TOKEN_BUDGET_LIST * 0.8);

      let budgetTokens = 0;
      let sessionsShown = 0;
      let budgetTruncated = false;

      const lines: string[] = [];

      for (const { session, observations } of sessionsWithObs) {
        const sessionTokens = observations.reduce((sum, o) => sum + o.token_estimate, 0);
        // Always show at least one session even if it alone exceeds the budget.
        if (sessionsShown > 0 && budgetTokens + sessionTokens > effectiveBudget) {
          budgetTruncated = true;
          break;
        }
        budgetTokens += sessionTokens;
        sessionsShown++;
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
          const branchTag = obs.branch ? ` [${obs.branch}]` : '';
          const supersededTag = obs.superseded_by != null ? ` [superseded by #${obs.superseded_by}]` : '';
          lines.push(`  [HIGH]${supersededTag} ${obs.tool_name}:${branchTag} ${obs.summary.substring(0, 80)}${fileInfo}`);
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

      if (budgetTruncated) {
        lines.push('');
        lines.push(`[Budget: showing ${sessionsShown} of ${sessionsWithObs.length} sessions. Use context_search for full history.]`);
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
    'context_add',
    'Write a manual observation into the context store. Use this to save notes, decisions, or insights from any MCP client (Claude Desktop, etc.), not just Claude Code sessions. Observations are stored with the project scope and become searchable via context_search.',
    {
      text: z.string().min(1).describe('The observation content to store'),
      project: z
        .string()
        .optional()
        .describe('Project path to scope the observation. Omit to use the server default project.'),
      importance: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Importance level: "high" (0.80), "medium" (0.60, default), "low" (0.40), or a float 0.0–1.0'),
      tags: z
        .string()
        .optional()
        .describe('Comma-separated domain tags. Developer: auth, database, testing, infra, config, frontend, api, git, build, deps. Personal ops: home, lawn, finance, health, travel, planning, decision, personal. If omitted, no tags are assigned.'),
      client: z
        .string()
        .optional()
        .describe('Identifier for the calling client (e.g. "Desktop", "Script"). Stored as tool_name Manual:ClientName for filtering. Omit for generic Manual writes.'),
    },
    async ({ text, project, importance, tags, client }) => {
      // Fix #81: Reject whitespace-only text
      const trimmedText = text.trim();
      if (!trimmedText) {
        return {
          content: [{ type: 'text' as const, text: 'Error: text must not be empty or whitespace-only.' }],
        };
      }

      // Resolve the project path: explicit param > server-configured default
      const resolvedProject = np(project) ?? project ?? process.cwd();

      // Warn if the resolved project path does not exist on disk.
      // This runs on the client machine in both local and proxy modes, helping
      // callers catch typos before observations are silently mis-scoped.
      let pathWarning = '';
      if (resolvedProject && !existsSync(resolvedProject)) {
        pathWarning = `\nNote: project path '${resolvedProject}' does not exist on disk. Observations will only be visible when searching from this exact path.`;
      }

      // Fix #82: Resolve importance score with clamping warning and error on unrecognized string
      let importanceScore = 0.60; // default: medium
      let importanceWarning = '';
      if (importance !== undefined) {
        if (typeof importance === 'number') {
          const clamped = Math.max(0.0, Math.min(1.0, importance));
          if (clamped !== importance) {
            importanceWarning = ` [warning: importance ${importance} clamped to ${clamped}]`;
          }
          importanceScore = clamped;
        } else {
          switch (importance.trim().toLowerCase()) {
            case 'high':   importanceScore = 0.80; break;
            case 'medium': importanceScore = 0.60; break;
            case 'low':    importanceScore = 0.40; break;
            default: {
              const parsed = parseFloat(importance);
              if (isNaN(parsed)) {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `Error: unrecognized importance value '${importance}'. Use 'high', 'medium', 'low', or a float 0.0–1.0.`,
                    },
                  ],
                };
              }
              const clamped = Math.max(0.0, Math.min(1.0, parsed));
              if (clamped !== parsed) {
                importanceWarning = ` [warning: importance ${parsed} clamped to ${clamped}]`;
              }
              importanceScore = clamped;
              break;
            }
          }
        }
      }

      // Resolve importance level label for the confirmation message
      let importanceLabel: string;
      if (importanceScore >= 0.65) {
        importanceLabel = 'high';
      } else if (importanceScore >= 0.35) {
        importanceLabel = 'medium';
      } else {
        importanceLabel = 'low';
      }

      // Fix #83: Tag validation against allowed set with feedback on rejected tags
      let resolvedTags: string | undefined;
      let tagNote = '';
      if (tags !== undefined) {
        const requested = tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        const applied = requested.filter(t => ALLOWED_OBSERVATION_TAGS.has(t as ObservationTag));
        const rejected = requested.filter(t => !ALLOWED_OBSERVATION_TAGS.has(t as ObservationTag));
        resolvedTags = applied.length > 0 ? applied.join(',') : undefined;
        if (rejected.length > 0) {
          tagNote = ` [tags rejected (not in allowed set): ${rejected.join(', ')}]`;
        }
      }

      // Sanitize client: strip control characters and cap length to match the server's guard.
      // Prevents newline injection into tool_name and keeps both local and proxy paths consistent.
      const sanitizedClient = client
        ? (client.replace(/[\x00-\x1f]/g, '').substring(0, 50) || undefined)
        : undefined;

      const clientNote = sanitizedClient ? `, client: ${sanitizedClient}` : '';

      if (isProxy) {
        // Forward to the remote server's /capture/add endpoint
        const { remoteAddObservation } = await import('../capture/remote-client.js');
        const remoteClient = { url: remoteUrl, token: remoteToken };
        const sessionId = await remoteAddObservation(remoteClient, {
          text: trimmedText,
          project: resolvedProject,
          importanceScore,
          tags: resolvedTags,
          sourceClient: sanitizedClient,
        });

        const preview = trimmedText.length > 60 ? trimmedText.substring(0, 60) + '...' : trimmedText;
        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved: "${preview}" (importance: ${importanceLabel}, session: ${sessionId ?? 'unknown'}${clientNote})${importanceWarning}${tagNote}${pathWarning}`,
            },
          ],
        };
      }

      const db = await getDb();
      const sessionId = await db.getOrCreateManualSession(resolvedProject);
      const obsId = await db.addManualObservation({
        text: trimmedText,
        project: resolvedProject,
        sessionId,
        importanceScore,
        tags: resolvedTags,
        client: sanitizedClient,
      });

      const preview = trimmedText.length > 60 ? trimmedText.substring(0, 60) + '...' : trimmedText;
      const dedupNote = obsId === undefined ? ' (duplicate, not stored)' : '';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved: "${preview}" (importance: ${importanceLabel}, session: ${sessionId}${clientNote})${importanceWarning}${dedupNote}${tagNote}${pathWarning}`,
          },
        ],
      };
    }
  );

  server.tool(
    'context_list_projects',
    'List all project paths that have observations, with observation counts and last activity. Useful for discovering existing project scopes before writing with context_add.',
    {},
    async () => {
      if (isProxy) {
        return proxyToolCall('context_list_projects', {}, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const projects: ProjectEntry[] = await db.getProjects();

      if (projects.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No projects found. Use context_add to write the first observation.' }],
        };
      }

      const lines = projects.map(p => {
        const date = new Date(p.last_activity).toLocaleDateString();
        return `${p.path}  (${p.observation_count} obs, last: ${date})`;
      });

      return {
        content: [{ type: 'text' as const, text: `${projects.length} project(s):\n\n${lines.join('\n')}` }],
      };
    }
  );

  server.tool(
    'context_lessons',
    'List past failures and error lessons for a project. Returns failed commands, build errors, test failures, and permission errors captured during prior sessions. Useful for avoiding repeated mistakes.',
    {
      project: z.string().optional().describe('Project path to scope the results. Omit to search all projects.'),
      query: z.string().optional().describe('Filter by keyword in the lesson summary'),
      lesson_type: z
        .enum(['error', 'build_failure', 'test_failure', 'permission_denied'])
        .optional()
        .describe('Filter to a specific lesson type'),
      limit: z.number().int().min(1).max(50).default(20).optional().describe('Maximum results to return (default: 20, max: 50)'),
      days: z.number().int().min(1).optional().describe('Only return lessons from the last N days'),
    },
    async ({ project, query, lesson_type, limit, days }) => {
      if (isProxy) {
        return proxyToolCall('context_lessons', { project: np(project), query, lesson_type, limit, days }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const normalizedProject = np(project);
      const since = days !== undefined
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
      const lessons = await db.getLessons(normalizedProject, query, lesson_type, limit ?? 20, since);
      const text = formatLessons(lessons);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'context_decisions',
    'List architectural decisions and approach choices made during prior sessions. Returns decisions in reverse chronological order with decision number, date, and decision text. Use to answer "what was decided about X?" without a full search.',
    {
      project: z.string().optional().describe('Project path to scope the results. Omit to search all projects.'),
      query: z.string().optional().describe('Keyword filter against decision text'),
      limit: z.number().int().min(1).max(50).default(20).optional().describe('Maximum results to return (default: 20, max: 50)'),
    },
    async ({ project, query, limit }) => {
      if (isProxy) {
        return proxyToolCall('context_decisions', { project: np(project), query, limit }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      // When no project is specified, use '/' to match all projects via LIKE '/%'
      const normalizedProject = np(project) ?? '/';
      const decisions = await db.searchDecisions(normalizedProject, query, limit ?? 20);
      const text = formatDecisions(decisions);
      return { content: [{ type: 'text' as const, text }] };
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
        const totalEmbeddedSessions = await db.countEmbeddedSessions(normalizedProject);
        sessionEmbeddingStats = {
          embedded: totalEmbeddedSessions,
          pending: pendingSessions,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: formatStats(stats, normalizedProject, vectorStats, sessionEmbeddingStats, resolvedVersion),
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
    'Clean up old observations and optimize the context-manager database. Use for maintenance. High-importance (score >= 0.65), pinned, and lesson observations are protected by default. Pass include_high: true to override.',
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
      include_high: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'When true, bypass the protection guard and also delete high-importance (score >= 0.65), pinned, and lesson observations. Default: false.'
        ),
    },
    async ({ days, stale_session_hours, include_high }) => {
      if (isProxy) {
        return proxyToolCall('context_vacuum', { days, stale_session_hours, include_high }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const result = await db.vacuum(days, stale_session_hours, include_high);

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
    'Targeted pruning of observations by tool name, importance, and/or age. Safer than context_vacuum: filters precisely rather than deleting by age alone. Use dry_run=true first to preview what would be deleted. At least one filter is required. High-importance (score >= 0.65), pinned, and lesson observations are protected by default. Pass include_high: true to override.',
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
      include_high: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'When true, bypass the protection guard and also delete high-importance (score >= 0.65), pinned, and lesson observations. Default: false.'
        ),
    },
    async ({ tool_name, importance, older_than_days, dry_run, include_high }) => {
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
        return proxyToolCall('context_prune', { tool_name, importance, older_than_days, dry_run, include_high }, remoteUrl, remoteToken);
      }

      const db = await getDb();
      const result = await db.prune({
        toolName: tool_name,
        importance: importance as ImportanceLevel | undefined,
        olderThanDays: older_than_days,
        dryRun: dry_run,
        include_high,
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

  server.tool(
    'context_reflect',
    'Analyze accumulated observations for a project and identify recurring patterns. Groups high-importance observations by tag, finds themes appearing across 3 or more observations, and produces proposed CLAUDE.md additions. No LLM inference -- deterministic pattern matching only.',
    {
      project: z.string().optional(),
      lookback_days: z.number().int().min(1).max(365).default(30).optional(),
      min_importance: z.number().min(0).max(1).default(0.65).optional(),
    },
    async ({ project, lookback_days, min_importance }) => {
      if (isProxy) {
        return proxyToolCall(
          'context_reflect',
          { project: np(project), lookback_days, min_importance },
          remoteUrl,
          remoteToken
        );
      }

      const db = await getDb();
      const normalizedProject = np(project) ?? project ?? process.cwd();
      const days = lookback_days ?? 30;
      const minScore = min_importance ?? 0.65;

      const observations = await db.getObservationsForReflection(
        normalizedProject,
        days,
        minScore
      );
      const result = buildReflection(normalizedProject, observations, days);
      const text = formatReflection(result);

      // Only record the date when a meaningful reflection ran
      if (result.tagGroups.length > 0) {
        await db.setLastReflectionDate(normalizedProject, new Date().toISOString());
      }

      return { content: [{ type: 'text' as const, text }] };
    }
  );

  return server;
}
