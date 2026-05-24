/**
 * Storage Interface
 *
 * Abstract storage layer for context observations.
 * Allows multiple implementations (SQLite, HTTP client, etc.)
 */

export type ImportanceLevel = 'high' | 'medium' | 'low';
export type RelationshipType = 'same_file' | 'followed_by';
export type ObservationTag =
  | 'auth'
  | 'database'
  | 'testing'
  | 'infra'
  | 'config'
  | 'frontend'
  | 'api'
  | 'git'
  | 'build'
  | 'deps';

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
  created_at: string; // ISO 8601 timestamp
}

export interface Session {
  id: string;
  project: string;
  started_at: string; // ISO 8601 timestamp
  ended_at?: string;
  summary?: string;
  summary_extended?: string; // Top-3 scored narrative messages joined with separators
  status: 'active' | 'complete';
  similarity_score?: number; // Cosine similarity [0,1], only present on vector search results
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
   * @param project - Project path (optional, for project-scoped search)
   */
  search(query: string, project?: string): Promise<Observation[]>;

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
   * Vacuum old observations and orphaned sessions
   * @param olderThanDays - Delete observations older than this many days (optional)
   * @returns Count of deleted observations and orphaned sessions
   */
  vacuum(olderThanDays?: number): Promise<{
    observations: number;
    sessions: number;
    compacted: number;
    compacted_originals: number;
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
  isVectorSearchEnabled(): boolean;

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
  countUnembeddedSessions(project?: string): number;

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
  incrementFileEncounter(filePath: string, project: string, toolName: string): number;

  /**
   * Get observations related to a given observation via inferred relationships.
   * @param observationId - The observation to find relations for
   * @param types - Filter by relationship types (optional)
   * @param limit - Maximum results (default: 10)
   */
  getRelatedObservations(observationId: number, types?: RelationshipType[], limit?: number): Observation[];

  /**
   * Close storage connection
   */
  close(): void;
}
