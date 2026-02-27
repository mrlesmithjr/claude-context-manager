/**
 * Storage Interface
 *
 * Abstract storage layer for context observations.
 * Allows multiple implementations (SQLite, HTTP client, etc.)
 */

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
  created_at: string; // ISO 8601 timestamp
}

export interface Session {
  id: string;
  project: string;
  started_at: string; // ISO 8601 timestamp
  ended_at?: string;
  summary?: string;
  status: 'active' | 'complete';
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
   */
  save(observation: Omit<Observation, 'id'>): Promise<void>;

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
  endSession(sessionId: string, summary?: string): Promise<void>;

  /**
   * Get recent sessions for a project
   */
  getRecentSessions(project: string, limit: number): Promise<Session[]>;

  /**
   * Vacuum old observations and orphaned sessions
   * @param olderThanDays - Delete observations older than this many days (optional)
   * @returns Count of deleted observations and orphaned sessions
   */
  vacuum(olderThanDays?: number): Promise<{ observations: number; sessions: number }>;

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
   * Close storage connection
   */
  close(): void;
}
