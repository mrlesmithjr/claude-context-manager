/**
 * Storage Interface
 *
 * Abstract storage layer for context observations.
 * Allows multiple implementations (SQLite, HTTP client, etc.)
 */

export type ImportanceLevel = 'high' | 'medium' | 'low';

import type { TemporalMode } from '../utils/temporal.js';
export type { TemporalMode };

/**
 * Options for observation search. Passed to search() to control retrieval behavior.
 */
export interface SearchOptions {
  /** Project path to scope the search (optional). */
  project?: string;
  /** Maximum number of results to return (default: 50). */
  limit?: number;
  /**
   * Temporal intent classification. When 'current', recent results are boosted.
   * When 'historical', results are sorted chronologically ascending (oldest first).
   * When 'neutral' (default), existing relevance ordering is preserved.
   */
  temporalMode?: TemporalMode;
  /**
   * When true, skip the time-weighted decay adjustment. Used by context_list
   * to show raw importance scores for transparency.
   */
  skipDecay?: boolean;
}
export type RelationshipType = 'same_file' | 'followed_by' | 'cross_project_same_file';
export type ObservationTag =
  // Developer / code tags (inferred automatically by hook capture)
  | 'auth'
  | 'database'
  | 'testing'
  | 'infra'
  | 'config'
  | 'frontend'
  | 'api'
  | 'git'
  | 'build'
  | 'deps'
  | 'error'
  // Personal ops tags (for manual context_add writes from Desktop or scripts)
  | 'home'
  | 'lawn'
  | 'finance'
  | 'health'
  | 'travel'
  | 'planning'
  | 'decision'
  | 'personal';

export interface Observation {
  id?: number;
  project: string;
  package?: string; // For monorepo support
  session_id: string;
  tool_name: string;
  summary: string;
  files_touched: string[];
  metadata: Record<string, unknown>;
  token_estimate: number;
  importance: ImportanceLevel;
  importance_score: number; // 0.0 to 1.0
  is_compacted?: boolean;
  exported_at?: string; // ISO 8601 timestamp — when exported to auto-memory
  tags?: string[]; // Domain tags inferred at capture time (auth, database, testing, etc.)
  content_hash?: string; // SHA256 of summary+files_touched+stored_output, used for exact dedup
  similarity_score?: number; // Cosine similarity [0,1], only present on vector search results
  lesson_type?: string | null; // Lesson classification: 'error' | 'build_failure' | 'test_failure' | 'permission_denied' | null
  pinned?: number;        // 1 = exempt from decay, 0 = normal (default)
  access_count?: number;  // incremented each time observation is returned in search results
  created_at: string; // ISO 8601 timestamp
}

export interface Session {
  id: string;
  project: string;
  started_at: string; // ISO 8601 timestamp
  ended_at?: string;
  summary?: string;
  summary_extended?: string; // Top-3 scored narrative messages joined with separators
  enriched_text?: string; // Pre-built embedding text (set by addManualObservation; used by embedding loop)
  source?: string; // Session source: 'hook' | 'manual'
  status: 'active' | 'complete';
  similarity_score?: number; // Cosine similarity [0,1], only present on vector search results
  last_checkpoint_at?: number; // Unix epoch ms of last checkpoint run; NULL means no checkpoint yet
}

export interface Decision {
  id?: number;
  session_id: string;
  project: string;
  decision_text: string;
  context?: string | null;
  decision_number?: number | null;
  captured_at: string;
  importance_score?: number;
  tags?: string | null;
}

export interface UserPrompt {
  id?: number;
  session_id: string;
  project: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
}

export interface Stats {
  total_observations: number;
  total_sessions: number;
  oldest_observation: string | null;
  newest_observation: string | null;
  total_tokens: number;
  // Token economics
  avg_tokens_per_observation: number;
  avg_tokens_per_session: number;
  tokens_by_tool: Record<string, number>;
  token_budget: number;
  typical_injection_tokens: number;
  // Importance distribution
  importance_counts: { high: number; medium: number; low: number };
  // Compaction stats
  compacted_count: number;
  compacted_original_count: number;
  // Compaction activity
  compacted_last_24h: number;       // compacted observation groups written in the last 24h
  sessions_gc_last_24h: number;     // sessions closed by stale GC in the last 24h
  next_compaction_eligible: number; // individual observations currently eligible for next compaction run
}

export interface TimelineEntry {
  date: string; // ISO date (YYYY-MM-DD)
  tokens: number;
  observations: number;
  sessions: number;
}

export interface ProjectEntry {
  path: string;
  observation_count: number;
  last_activity: string;
}

export interface FileTouchEntry {
  file_path: string;
  touch_count: number;
}

export interface TagTrendEntry {
  week: string;       // Monday of the containing week (YYYY-MM-DD)
  tag: string;
  count: number;
}

export interface ProjectVelocityEntry {
  week: string;       // Monday of the containing week (YYYY-MM-DD)
  project: string;
  sessions: number;
  observations: number;
}

/**
 * Abstract storage interface for context observations
 */
export interface ContextStorage {
  /**
   * Initialize storage (create database, run migrations, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Save an observation
   * @returns The inserted observation ID, or undefined if deduplicated
   */
  save(observation: Omit<Observation, 'id'>): Promise<number | undefined>;

  /**
   * Get recent observations for a project
   * @param project - Project path
   * @param limit - Maximum number of observations to return
   */
  getRecent(project: string, limit: number): Promise<Observation[]>;

  /**
   * Get observations within a token budget
   * @param project - Project path
   * @param tokenBudget - Maximum tokens to return
   */
  getWithinBudget(project: string, tokenBudget: number): Promise<Observation[]>;

  /**
   * Full-text search observations
   * @param query - Search query
   * @param projectOrOptions - Project path string (legacy) or SearchOptions object
   */
  search(query: string, projectOrOptions?: string | SearchOptions): Promise<Observation[]>;

  /**
   * Search observations by domain tag
   * @param tag - Tag to filter by (auth, database, testing, etc.)
   * @param project - Project path (optional, for project-scoped search)
   * @param limit - Maximum results (default: 50)
   */
  searchByTag(tag: string, project?: string, limit?: number): Promise<Observation[]>;

  /**
   * Get statistics for a project
   * @param project - Project path (optional, for all projects)
   */
  getStats(project?: string): Promise<Stats>;

  /**
   * Create a new session
   */
  createSession(sessionId: string, project: string): Promise<void>;

  /**
   * End a session with optional summary
   */
  endSession(sessionId: string, summary?: string, summaryExtended?: string): Promise<void>;

  /**
   * Update sessions.summary with a draft narrative without changing status or ended_at.
   * Used by the checkpoint runner to write a best-effort summary before the session ends.
   * The Stop hook overwrites this with the final summary on clean exit.
   * @param sessionId - Session ID
   * @param summary - Draft summary text
   */
  updateSessionDraftSummary(sessionId: string, summary: string): Promise<void>;

  /**
   * Update the last_checkpoint_at timestamp for a session.
   * Called after a successful periodic checkpoint to record when it ran.
   * @param sessionId - Session ID
   * @param timestamp - Unix epoch milliseconds
   */
  updateSessionCheckpoint(sessionId: string, timestamp: number): Promise<void>;

  /**
   * Get the last_checkpoint_at and started_at for a session.
   * Used by the checkpoint runner to decide whether a checkpoint is due.
   * Returns null if the session does not exist.
   */
  getSessionTimestamps(sessionId: string): Promise<{ started_at: string; last_checkpoint_at: number | null } | null>;

  /**
   * Get recent sessions for a project
   */
  getRecentSessions(project: string, limit: number): Promise<Session[]>;

  /**
   * Get paginated sessions with observation count and token total in one query.
   * Replaces the N+1 pattern of getRecentSessions + per-session getSessionObservations.
   * @param project - Project path prefix (use '/' for all projects)
   * @param limit - Page size
   * @param offset - Page offset
   * @param status - Optional status filter ('active' | 'complete')
   */
  getRecentSessionsWithCounts(
    project: string,
    limit: number,
    offset: number,
    status?: string
  ): Promise<Array<Session & { observation_count: number; total_tokens: number }>>;

  /**
   * Close active sessions whose last activity is older than the given threshold.
   * Runs only the single stale-session UPDATE — no compaction, no ANALYZE, no VACUUM.
   * Extracted from vacuum() so the SessionStart hook can run it on every session open
   * without paying the full vacuum cost.
   *
   * @param staleSessionHours - Sessions with no activity older than this many hours are marked complete (default: 2)
   * @returns Number of sessions transitioned from active to complete
   */
  closeStaleActiveSessions(staleSessionHours?: number): Promise<number>;

  /**
   * Vacuum old observations and orphaned sessions
   * @param olderThanDays - Delete observations older than this many days (optional)
   * @param staleSessionHours - Mark active sessions with no activity older than this many hours as complete (default: 2)
   * @returns Count of deleted observations, orphaned sessions, and closed stale sessions
   */
  vacuum(olderThanDays?: number, staleSessionHours?: number): Promise<{
    observations: number;
    sessions: number;
    compacted: number;
    compacted_originals: number;
    closedStaleSessions: number;
  }>;

  /**
   * Targeted pruning of observations by tool name, importance, and/or age.
   * Safer than vacuum — filters precisely rather than deleting by age alone.
   * Requires at least one filter; returns 0 if none are provided.
   *
   * @param options.toolName - Filter by tool name (e.g., "Bash", "Read")
   * @param options.importance - Filter by importance level ("high" | "medium" | "low")
   * @param options.olderThanDays - Only prune observations older than this many days
   * @param options.dryRun - Preview count and samples without deleting (default: false)
   * @returns Count of deleted (or matching, if dry run) observations and optional samples
   */
  prune(options: {
    toolName?: string;
    importance?: ImportanceLevel;
    olderThanDays?: number;
    dryRun?: boolean;
  }): Promise<{ deleted: number; preview?: string[] }>;

  /**
   * Save a user prompt
   */
  saveUserPrompt(prompt: Omit<UserPrompt, 'id'>): Promise<void>;

  /**
   * Get recent user prompts for a project
   * @param project - Project path
   * @param limit - Maximum number of prompts to return
   */
  getRecentPrompts(project: string, limit: number): Promise<UserPrompt[]>;

  /**
   * Full-text search user prompts
   * @param query - Search query
   * @param project - Project path (optional, for project-scoped search)
   */
  searchPrompts(query: string, project?: string): Promise<UserPrompt[]>;

  /**
   * Get token usage timeline for analytics
   * @param project - Project path (optional, for project-scoped timeline)
   * @param days - Number of days to include (default: 30)
   */
  getTimeline(project?: string, days?: number): Promise<TimelineEntry[]>;

  /**
   * Top N files by touch count over the last `days` days.
   * @param project - Project path prefix filter (optional)
   * @param days - Lookback window in days (default: 30)
   * @param limit - Max files to return (default: 10)
   */
  getFileTouchFrequency(project?: string, days?: number, limit?: number): Promise<FileTouchEntry[]>;

  /**
   * Tag frequency bucketed by ISO week for the last N weeks.
   * @param project - Project path prefix filter (optional)
   * @param weeks - Lookback window in weeks (default: 12)
   */
  getTagTrend(project?: string, weeks?: number): Promise<TagTrendEntry[]>;

  /**
   * Sessions and observations per project per week for the last N weeks.
   * @param project - Project path prefix filter (optional)
   * @param weeks - Lookback window in weeks (default: 12)
   */
  getProjectVelocity(project?: string, weeks?: number): Promise<ProjectVelocityEntry[]>;

  /**
   * Get list of unique projects with activity stats
   */
  getProjects(): Promise<ProjectEntry[]>;

  /**
   * Get observations for a specific session
   * @param sessionId - Session ID
   */
  getSessionObservations(sessionId: string): Promise<Observation[]>;

  /**
   * Get prompts for a specific session
   * @param sessionId - Session ID
   */
  getSessionPrompts(sessionId: string): Promise<UserPrompt[]>;

  /**
   * Get candidate observations for relevance-based injection
   * Pre-filters low-importance, fetches larger pool for scoring
   * @param project - Project path
   * @param limit - Max candidates to fetch (default: 200)
   */
  getRelevantCandidates(project: string, limit?: number): Promise<Observation[]>;

  /**
   * Compact old observations into summaries
   * Groups old observations by session + tool, compresses into single entries
   * @param olderThanDays - Compact observations older than this (default: 7)
   * @returns Count of observations compacted and originals removed
   */
  compactObservations(olderThanDays?: number): Promise<{ compacted: number; originals: number }>;

  /**
   * Get high-importance observations that haven't been exported to auto-memory
   * @param project - Project path
   * @param sessionId - Optional session ID filter
   * @param minScore - Minimum importance score (default: 0.65)
   */
  getUnexportedHighImportance(project: string, sessionId?: string, minScore?: number): Promise<Observation[]>;

  /**
   * Mark observations as exported to auto-memory
   * @param ids - Observation IDs to mark
   */
  markExported(ids: number[]): Promise<void>;

  /**
   * Count observations with optional filters
   * @param project - Project path (optional)
   * @param tool - Tool name filter (optional)
   */
  countObservations(project?: string, tool?: string): Promise<number>;

  /**
   * Count sessions with optional filters
   * @param project - Project path (optional)
   * @param status - Status filter: 'active' or 'complete' (optional)
   */
  countSessions(project?: string, status?: string): Promise<number>;

  /**
   * Check if vector search (sqlite-vec) is available
   */
  isVectorSearchEnabled(): Promise<boolean>;

  /**
   * Save an embedding for an observation
   * @param id - Observation ID
   * @param embedding - Float32Array of embedding values (384-dim)
   */
  saveEmbedding(id: number, embedding: Float32Array): Promise<void>;

  /**
   * Search observations by vector similarity
   * @param embedding - Query embedding (384-dim Float32Array)
   * @param project - Project path (optional, for project-scoped search)
   * @param topK - Maximum results to return (default: 10)
   */
  vectorSearch(embedding: Float32Array, project?: string, topK?: number): Promise<Observation[]>;

  /**
   * Get observations that don't have embeddings yet
   * @param limit - Maximum number to return (default: 100)
   * @param project - Project path (optional)
   */
  getUnembeddedObservations(limit?: number, project?: string): Promise<Observation[]>;

  /**
   * Save a session-level embedding
   * @param sessionId - Session ID
   * @param embedding - Float32Array of embedding values (384-dim)
   * @param enrichedText - The enriched text that was embedded (stored for debugging)
   */
  saveSessionEmbedding(sessionId: string, embedding: Float32Array, enrichedText: string): Promise<void>;

  /**
   * Search sessions by vector similarity
   * @param embedding - Query embedding (384-dim Float32Array)
   * @param project - Project path (optional, for project-scoped search)
   * @param topK - Maximum results to return (default: 10)
   */
  vectorSearchSessions(embedding: Float32Array, project?: string, topK?: number): Promise<Session[]>;

  /**
   * Get sessions that don't have embeddings yet (complete sessions only)
   * @param limit - Maximum number to return (default: 50)
   * @param project - Project path (optional)
   */
  getUnembeddedSessions(limit?: number, project?: string): Promise<Session[]>;

  /**
   * Count sessions missing embeddings
   * @param project - Project path (optional)
   */
  countUnembeddedSessions(project?: string): Promise<number>;

  /**
   * Count sessions that have embeddings (complete or manual with enriched_text)
   * @param project - Project path (optional)
   */
  countEmbeddedSessions(project?: string): Promise<number>;

  /**
   * Get recent sessions with their observations, grouped for display.
   * @param project - Project path
   * @param sessionLimit - Maximum number of sessions (default: 10)
   */
  getRecentSessionsWithObservations(
    project: string,
    sessionLimit?: number
  ): Promise<Array<{ session: Session; observations: Observation[] }>>;

  /**
   * Increment file encounter count and return the new count.
   * Used for surprise scoring — first encounters get boosted importance.
   */
  incrementFileEncounter(filePath: string, project: string, toolName: string): Promise<number>;

  /**
   * Get observations related to a given observation via inferred relationships.
   * @param observationId - The observation to find relations for
   * @param types - Filter by relationship types (optional)
   * @param limit - Maximum results (default: 10)
   */
  getRelatedObservations(observationId: number, types?: RelationshipType[], limit?: number): Promise<Observation[]>;

  /**
   * Get prior observations about a specific file from previous sessions.
   *
   * Used by the PreToolUse file-context hook to inject compact history when
   * Claude opens a file it has worked on before. Only returns observations
   * from sessions other than the current one, ordered by recency.
   *
   * Searches files_touched (JSON array stored as text) — not summary — for
   * the file path.
   *
   * @param filePath - Absolute file path to look up
   * @param projectPrefix - Project path prefix for scoped search
   * @param excludeSessionId - Session ID to exclude (current session)
   * @param limit - Maximum results (default: 3)
   */
  getFileHistory(
    filePath: string,
    projectPrefix: string,
    excludeSessionId: string,
    limit: number
  ): Promise<Observation[]>;

  /**
   * Check whether the current session already has an observation touching the
   * given file. Uses a single indexed SQL query instead of loading all session
   * observations into memory. Used by the file-context hook Guard 1.
   *
   * @param sessionId - Session ID to check
   * @param likePattern - LIKE-escaped pattern for the file path (e.g. "%file.ts%")
   */
  hasSessionSeenFile(sessionId: string, likePattern: string): Promise<boolean>;

  /**
   * Get the highest-scored Conversation observation for a session.
   * Used as a fallback summary source when narrative scoring yields a low score,
   * which happens in discussion/planning sessions that produce no code-change signals.
   *
   * Returns null when no Conversation observation exists for the session.
   *
   * @param sessionId - Session ID to query
   */
  getTopConversationObservation(sessionId: string): Promise<Observation | null>;

  /**
   * Get or create the daily "manual" session for a project.
   * One manual session is reused per calendar day per project so that multiple
   * context_add calls within the same day share a single session row.
   *
   * @param project - Project path to scope the session
   * @returns The session ID (existing or newly created)
   */
  getOrCreateManualSession(project: string): Promise<string>;

  /**
   * Save a manually-written observation from the context_add MCP tool.
   * Skips surprise scoring and relationship inference (no file path context).
   *
   * @param params.text - Observation content
   * @param params.project - Project path
   * @param params.sessionId - Session ID (from getOrCreateManualSession)
   * @param params.importanceScore - Numeric score 0.0–1.0
   * @param params.tags - Domain tags (comma-separated string or undefined)
   * @param params.client - Optional calling client identifier (e.g. "Desktop", "Script").
   *   Stored as tool_name "Manual:ClientName" when provided; "Manual" when omitted.
   * @returns The inserted observation ID, or undefined if deduplicated
   */
  addManualObservation(params: {
    text: string;
    project: string;
    sessionId: string;
    importanceScore: number;
    tags: string | undefined;
    client?: string;
  }): Promise<number | undefined>;

  /**
   * Fetch full Observation objects for a list of IDs.
   * IDs that do not exist in the database are silently skipped.
   * Results are returned in ascending created_at order.
   *
   * @param ids - Array of integer observation rowids (max 20)
   */
  getObservationsByIds(ids: number[]): Promise<Observation[]>;

  /**
   * Get related observation references for a given observation ID.
   * Returns the related observation's ID and the relationship type.
   * Checks both source_id and target_id columns so direction does not matter.
   *
   * @param id - The observation ID to find relations for
   * @returns Array of { id, relationship } pairs (max 5)
   */
  getRelatedObservationRefs(id: number): Promise<Array<{ id: number; relationship: string }>>;

  /**
   * Fetch neighboring observations in the same session around a given ID.
   * Used by context_timeline to provide chronological context.
   *
   * @param id - The target observation ID
   * @param window - Number of observations to include on each side (default: 3)
   * @returns before (reversed to chronological), target, after arrays
   *   If the target ID does not exist, returns null.
   */
  getObservationNeighbors(
    id: number,
    window: number
  ): Promise<{ before: Observation[]; target: Observation; after: Observation[] } | null>;

  /**
   * Get lesson observations (failed commands, build errors, test failures, permission errors).
   * Returns observations where lesson_type IS NOT NULL, optionally filtered by project,
   * lesson_type, a keyword in the summary, and a date threshold.
   *
   * @param project - Project path prefix (optional; omit for all projects)
   * @param query - Keyword filter applied to summary (optional)
   * @param lessonType - Filter to a specific lesson type (optional)
   * @param limit - Maximum results to return (default: 20)
   * @param since - ISO 8601 date string; only return observations on or after this date (optional)
   */
  getLessons(project?: string, query?: string, lessonType?: string, limit?: number, since?: string): Promise<Observation[]>;

  /**
   * Save a decision to the decisions table with FTS5 index update.
   * @param decision - Decision object (id is auto-assigned)
   */
  saveDecision(decision: Decision): Promise<void>;

  /**
   * Search decisions for a project, optionally filtered by keyword query.
   * @param project - Project path prefix
   * @param query - Optional keyword filter applied against decision_text and context via FTS5
   * @param limit - Maximum results (default: 20)
   */
  searchDecisions(project: string, query?: string, limit?: number): Promise<Decision[]>;

  /**
   * Get the next sequential decision number for a project.
   * @param project - Project path prefix
   */
  getNextDecisionNumber(project: string): Promise<number>;

  /**
   * Get observations suitable for reflection analysis.
   * Returns high-importance, non-superseded observations from the lookback window,
   * ordered by importance descending then recency descending, capped at 500.
   *
   * @param project - Project path prefix
   * @param lookbackDays - Number of days to look back from now
   * @param minImportance - Minimum importance_score threshold (0.0-1.0)
   */
  getObservationsForReflection(
    project: string,
    lookbackDays: number,
    minImportance: number
  ): Promise<Observation[]>;

  /**
   * Get the ISO date string of the last reflection run for a project.
   * Returns null when no reflection has been run yet.
   *
   * @param project - Project path
   */
  getLastReflectionDate(project: string): Promise<string | null>;

  /**
   * Store the ISO date string of a completed reflection run for a project.
   *
   * @param project - Project path
   * @param date - ISO date string to store
   */
  setLastReflectionDate(project: string, date: string): Promise<void>;

  /**
   * Close storage connection
   */
  close(): Promise<void>;
}
