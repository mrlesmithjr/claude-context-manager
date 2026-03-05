/**
 * SQLite Storage Implementation
 *
 * Direct SQLite storage using better-sqlite3 with P1 security fixes:
 * - Foreign keys enabled
 * - FTS5 with NULL handling via COALESCE
 * - Prepared statements
 * - Transaction support
 */

import Database from 'better-sqlite3';
import { homedir } from 'os';
import path from 'path';
import { mkdirSync } from 'fs';
import type {
  ContextStorage,
  Observation,
  ImportanceLevel,
  Session,
  Stats,
  UserPrompt,
  TimelineEntry,
  ProjectEntry,
} from './interface.js';

const DEFAULT_DB_PATH = path.join(homedir(), '.claude-context', 'context.db');

export class SQLiteStorage implements ContextStorage {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent access
    this.db.pragma('journal_mode = WAL');

    // CRITICAL P1 FIX: Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  async initialize(): Promise<void> {
    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT,
        status TEXT DEFAULT 'active'
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    `);

    // Create user_prompts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_prompts_project_created
      ON user_prompts(project, created_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id);
    `);

    // Create FTS5 virtual table for user_prompts
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
        prompt_text,
        content=user_prompts,
        content_rowid=id
      );
    `);

    // FTS triggers for user_prompts
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS user_prompts_ai AFTER INSERT ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, COALESCE(new.prompt_text, ''));
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS user_prompts_ad AFTER DELETE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS user_prompts_au AFTER UPDATE ON user_prompts BEGIN
        INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
        VALUES('delete', old.id, old.prompt_text);
        INSERT INTO user_prompts_fts(rowid, prompt_text)
        VALUES (new.id, COALESCE(new.prompt_text, ''));
      END;
    `);

    // Create observations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        package TEXT,
        tool_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_touched TEXT,
        metadata TEXT,
        token_estimate INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    // CRITICAL P1 FIX: Composite index for common query pattern
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_created
      ON observations(project, created_at DESC);
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    `);

    // Create FTS5 virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        summary,
        files_touched,
        metadata,
        content=observations,
        content_rowid=id
      );
    `);

    // CRITICAL P1 FIX: FTS triggers with COALESCE for NULL handling
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, summary, files_touched, metadata)
        VALUES (
          new.id,
          COALESCE(new.summary, ''),
          COALESCE(new.files_touched, ''),
          COALESCE(new.metadata, '')
        );
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, summary, files_touched, metadata)
        VALUES('delete', old.id, old.summary, old.files_touched, old.metadata);
      END;
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, summary, files_touched, metadata)
        VALUES('delete', old.id, old.summary, old.files_touched, old.metadata);
        INSERT INTO observations_fts(rowid, summary, files_touched, metadata)
        VALUES (
          new.id,
          COALESCE(new.summary, ''),
          COALESCE(new.files_touched, ''),
          COALESCE(new.metadata, '')
        );
      END;
    `);

    // Migration: add importance scoring columns
    this.migrateAddImportanceColumns();
  }

  /**
   * Add importance and compaction columns if they don't exist.
   * Uses pragma table_info to check column existence safely.
   */
  private migrateAddImportanceColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('importance')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN importance TEXT DEFAULT 'medium'`);
    }
    if (!columnNames.has('importance_score')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5`);
    }
    if (!columnNames.has('is_compacted')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN is_compacted INTEGER DEFAULT 0`);
    }

    // Index for relevance-based queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_score
      ON observations(project, importance_score DESC, created_at DESC)
    `);
  }

  /**
   * Normalize summary text for dedup comparison.
   * Groups similar observations that differ only in variable query text.
   */
  private normalizeSummaryForDedup(summary: string, toolName: string): string {
    // psql: normalize to connection/command prefix, strip variable query text
    if (summary.includes('psql')) {
      const match = summary.match(/^(Bash:\s*docker\s+exec\s+\S+\s+psql\b)/);
      if (match?.[1]) return match[1];
      const psqlMatch = summary.match(/^(Bash:\s*psql\b[^|;]*)/);
      if (psqlMatch?.[1]) return psqlMatch[1].substring(0, 40);
    }

    // git status/diff/log: first 20 chars (always identical command prefix)
    if (/^Bash:\s*git\s+(status|diff|log)\b/.test(summary)) {
      return summary.substring(0, 20);
    }

    // Default: 60-char prefix
    return summary.substring(0, 60);
  }

  /**
   * Map a database row to an Observation object
   */
  private mapRow(row: Record<string, unknown>): Observation {
    return {
      id: row.id as number,
      session_id: row.session_id as string,
      project: row.project as string,
      package: (row.package as string) || undefined,
      tool_name: row.tool_name as string,
      summary: row.summary as string,
      files_touched: JSON.parse((row.files_touched as string) || '[]'),
      metadata: JSON.parse((row.metadata as string) || '{}'),
      token_estimate: row.token_estimate as number,
      importance: (row.importance as ImportanceLevel) || 'medium',
      importance_score: (row.importance_score as number) ?? 0.5,
      is_compacted: (row.is_compacted as number) === 1,
      created_at: row.created_at as string,
    };
  }

  async save(observation: Omit<Observation, 'id'>): Promise<void> {
    // Deduplication: skip if very similar observation exists recently
    // CROSS-SESSION deduplication within same project (not just same session)
    // Window varies by command type based on data analysis:
    // - psql queries: 99% duplication rate, use 60 minute window + normalized prefix
    // - ssh commands: often repeated, use 10 minute window
    // - gh commands: repeated issue/PR lists, use 5 minute window
    // - Read tool: re-reading files is very common, use 10 minute window
    // - Grep/Glob: repeated searches, use 5 minute window
    // - Edit: related edits on same file, use 2 minute window
    // - default: 5 minutes same-session (catches re-reads of same files)
    const summaryPrefix = this.normalizeSummaryForDedup(observation.summary, observation.tool_name);

    let dedupeWindowMs = 300000; // default 5 minutes (same session)
    let crossSession = false;     // whether to dedupe across sessions

    if (observation.summary.includes('psql')) {
      dedupeWindowMs = 3600000; // 60 minutes for psql (cross-session) - 99% dup rate
      crossSession = true;
    } else if (observation.summary.startsWith('Bash: ssh ')) {
      dedupeWindowMs = 600000; // 10 minutes for ssh (cross-session)
      crossSession = true;
    } else if (observation.summary.includes('gh issue') || observation.summary.includes('gh pr')) {
      dedupeWindowMs = 300000; // 5 minutes for gh commands (cross-session)
      crossSession = true;
    } else if (observation.tool_name === 'Read') {
      dedupeWindowMs = 600000; // 10 minutes for Read (re-reading files is very common)
      crossSession = false;
    } else if (observation.tool_name === 'Grep' || observation.tool_name === 'Glob') {
      dedupeWindowMs = 300000; // 5 minutes for search tools
      crossSession = false;
    } else if (observation.tool_name === 'Edit') {
      dedupeWindowMs = 120000; // 2 minutes for Edit deduplication
      crossSession = false;
    }

    const windowStart = new Date(Date.now() - dedupeWindowMs).toISOString();
    const prefixLen = summaryPrefix.length;

    // Cross-session: check by project, same-session: check by session_id
    const duplicateCheck = crossSession
      ? this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE project = ?
            AND substr(summary, 1, ?) = ?
            AND created_at > ?
        `)
      : this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE session_id = ?
            AND substr(summary, 1, ?) = ?
            AND created_at > ?
        `);

    const checkKey = crossSession ? observation.project : observation.session_id;
    const result = duplicateCheck.get(checkKey, prefixLen, summaryPrefix, windowStart) as { count: number };

    if (result.count > 0) {
      // Skip duplicate - already have a similar observation recently
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, package, tool_name, summary,
        files_touched, metadata, token_estimate,
        importance, importance_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      observation.session_id,
      observation.project,
      observation.package || null,
      observation.tool_name,
      observation.summary,
      JSON.stringify(observation.files_touched),
      JSON.stringify(observation.metadata),
      observation.token_estimate,
      observation.importance || 'medium',
      observation.importance_score ?? 0.5,
      observation.created_at
    );
  }

  async getRecent(project: string, limit: number): Promise<Observation[]> {
    // Use LIKE for prefix matching (parent directory sees children)
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(project + '%', limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async getWithinBudget(
    project: string,
    tokenBudget: number
  ): Promise<Observation[]> {
    // Apply 80% safety margin
    const effectiveBudget = Math.floor(tokenBudget * 0.8);

    // Use LIKE for prefix matching (parent directory sees children)
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
      ORDER BY created_at DESC
    `);

    const rows = stmt.all(project + '%') as Array<Record<string, unknown>>;

    // Accumulate observations until budget exceeded
    const results: Observation[] = [];
    let totalTokens = 0;

    for (const row of rows) {
      const tokenEstimate = row.token_estimate as number;
      if (totalTokens + tokenEstimate > effectiveBudget) {
        break;
      }

      results.push(this.mapRow(row));
      totalTokens += tokenEstimate;
    }

    return results;
  }

  async search(query: string, project?: string): Promise<Observation[]> {
    let sql: string;
    let params: unknown[];

    if (project) {
      // Use LIKE for prefix matching (parent directory sees children)
      // FTS5 requires full table name in MATCH clause (aliases don't work)
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [query, project + '%'];
    } else {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [query];
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async getStats(project?: string): Promise<Stats> {
    const TOKEN_BUDGET = parseInt(
      process.env.CONTEXT_MANAGER_TOKEN_BUDGET || '4000',
      10
    );

    // Base observation stats
    const baseSql = project
      ? `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens,
          AVG(token_estimate) as avg_tokens
        FROM observations
        WHERE project LIKE ? || '%'
      `
      : `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens,
          AVG(token_estimate) as avg_tokens
        FROM observations
      `;

    const baseRow = this.db.prepare(baseSql).get(
      ...(project ? [project] : [])
    ) as {
      total_observations: number;
      oldest_observation: string | null;
      newest_observation: string | null;
      total_tokens: number | null;
      avg_tokens: number | null;
    };

    // Session count
    const sessionSql = project
      ? 'SELECT COUNT(*) as count FROM sessions WHERE project LIKE ? || \'%\''
      : 'SELECT COUNT(*) as count FROM sessions';

    const sessionRow = this.db.prepare(sessionSql).get(
      ...(project ? [project] : [])
    ) as { count: number };

    // Tokens by tool type
    const toolSql = project
      ? `
        SELECT tool_name, SUM(token_estimate) as tokens
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY tool_name
        ORDER BY tokens DESC
      `
      : `
        SELECT tool_name, SUM(token_estimate) as tokens
        FROM observations
        GROUP BY tool_name
        ORDER BY tokens DESC
      `;

    const toolRows = this.db.prepare(toolSql).all(
      ...(project ? [project] : [])
    ) as Array<{ tool_name: string; tokens: number }>;

    const tokensByTool: Record<string, number> = {};
    for (const row of toolRows) {
      tokensByTool[row.tool_name] = row.tokens;
    }

    // Average tokens per session (sum tokens / session count)
    const avgTokensPerSession =
      sessionRow.count > 0 ? Math.round((baseRow.total_tokens || 0) / sessionRow.count) : 0;

    // Typical injection: get median of recent injection sizes
    // Approximated by looking at what would be injected for recent sessions
    const recentSql = project
      ? `
        SELECT SUM(token_estimate) as session_tokens
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC
        LIMIT 10
      `
      : `
        SELECT SUM(token_estimate) as session_tokens
        FROM observations
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC
        LIMIT 10
      `;

    const recentRows = this.db.prepare(recentSql).all(
      ...(project ? [project] : [])
    ) as Array<{ session_tokens: number }>;

    // Typical injection is roughly min(avg recent session tokens, budget)
    const avgRecentTokens =
      recentRows.length > 0
        ? Math.round(
            recentRows.reduce((sum, r) => sum + r.session_tokens, 0) /
              recentRows.length
          )
        : 0;
    const typicalInjection = Math.min(avgRecentTokens, TOKEN_BUDGET);

    // Importance distribution
    const importanceSql = project
      ? `
        SELECT importance, COUNT(*) as cnt
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY importance
      `
      : `
        SELECT importance, COUNT(*) as cnt
        FROM observations
        GROUP BY importance
      `;

    const importanceRows = this.db.prepare(importanceSql).all(
      ...(project ? [project] : [])
    ) as Array<{ importance: string | null; cnt: number }>;

    const importanceCounts = { high: 0, medium: 0, low: 0 };
    for (const row of importanceRows) {
      const level = (row.importance || 'medium') as keyof typeof importanceCounts;
      if (level in importanceCounts) {
        importanceCounts[level] = row.cnt;
      }
    }

    // Compaction stats
    const compactedSql = project
      ? `
        SELECT
          COUNT(*) as compacted_count,
          COALESCE(SUM(json_extract(metadata, '$.compacted_from')), 0) as original_count
        FROM observations
        WHERE project LIKE ? || '%' AND is_compacted = 1
      `
      : `
        SELECT
          COUNT(*) as compacted_count,
          COALESCE(SUM(json_extract(metadata, '$.compacted_from')), 0) as original_count
        FROM observations
        WHERE is_compacted = 1
      `;

    const compactedRow = this.db.prepare(compactedSql).get(
      ...(project ? [project] : [])
    ) as { compacted_count: number; original_count: number } | undefined;

    return {
      total_observations: baseRow.total_observations,
      total_sessions: sessionRow.count,
      oldest_observation: baseRow.oldest_observation,
      newest_observation: baseRow.newest_observation,
      total_tokens: baseRow.total_tokens || 0,
      avg_tokens_per_observation: Math.round(baseRow.avg_tokens || 0),
      avg_tokens_per_session: avgTokensPerSession,
      tokens_by_tool: tokensByTool,
      token_budget: TOKEN_BUDGET,
      typical_injection_tokens: typicalInjection,
      importance_counts: importanceCounts,
      compacted_count: compactedRow?.compacted_count || 0,
      compacted_original_count: compactedRow?.original_count || 0,
    };
  }

  async createSession(sessionId: string, project: string): Promise<void> {
    // Use INSERT OR IGNORE to handle case where session already exists
    // (e.g., Claude Code reconnect/restart with same session ID)
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, started_at, status)
      VALUES (?, ?, ?, 'active')
    `);

    stmt.run(sessionId, project, new Date().toISOString());
  }

  async endSession(sessionId: string, summary?: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = ?, status = 'complete'
      WHERE id = ?
    `);

    stmt.run(new Date().toISOString(), summary || null, sessionId);
  }

  async getRecentSessions(project: string, limit: number): Promise<Session[]> {
    // Prioritize complete sessions with substantive summaries
    // Skip: empty summaries, agent sessions, generic messages, meta-discussions about context
    // Uses prefix matching: '/' matches all, '/Users/foo/Projects' matches that subtree
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE project LIKE ? || '%'
        AND (summary IS NOT NULL AND LENGTH(summary) > 0)
        AND id NOT LIKE 'agent-%'
        AND summary NOT LIKE '%I''ll wait for your request%'
        AND summary NOT LIKE '%I''m ready to help%'
        AND summary NOT LIKE '%No data from yesterday%'
        AND summary NOT LIKE '%context-manager%'
        AND summary NOT LIKE '%no context%'
      ORDER BY CASE WHEN status = 'complete' THEN 0 ELSE 1 END, started_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(project, limit) as Array<{
      id: string;
      project: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      status: 'active' | 'complete';
    }>;

    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || undefined,
      summary: row.summary || undefined,
      status: row.status,
    }));
  }

  async vacuum(olderThanDays?: number): Promise<{
    observations: number;
    sessions: number;
    compacted: number;
    compacted_originals: number;
  }> {
    let deletedObservations = 0;

    if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();

      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?
      `);

      const result = stmt.run(cutoffISO);
      deletedObservations = result.changes;
    }

    // Run compaction on observations older than 7 days
    const compactionResult = await this.compactObservations(7);

    // Clean up orphaned sessions (no observations AND no prompts)
    const orphanStmt = this.db.prepare(`
      DELETE FROM sessions
      WHERE id NOT IN (SELECT DISTINCT session_id FROM observations)
        AND id NOT IN (SELECT DISTINCT session_id FROM user_prompts)
    `);
    const orphanResult = orphanStmt.run();
    const deletedSessions = orphanResult.changes;

    // Update query planner statistics and reclaim space
    this.db.exec('ANALYZE');
    this.db.exec('VACUUM');

    return {
      observations: deletedObservations,
      sessions: deletedSessions,
      compacted: compactionResult.compacted,
      compacted_originals: compactionResult.originals,
    };
  }

  async saveUserPrompt(prompt: Omit<UserPrompt, 'id'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (
        session_id, project, prompt_number, prompt_text, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      prompt.session_id,
      prompt.project,
      prompt.prompt_number,
      prompt.prompt_text,
      prompt.created_at
    );
  }

  async getRecentPrompts(project: string, limit: number): Promise<UserPrompt[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(project, limit) as Array<{
      id: number;
      session_id: string;
      project: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at,
    }));
  }

  async searchPrompts(query: string, project?: string): Promise<UserPrompt[]> {
    let sql: string;
    let params: unknown[];

    if (project) {
      // FTS5 requires full table name in MATCH clause (aliases don't work)
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts ON p.id = user_prompts_fts.rowid
        WHERE user_prompts_fts MATCH ? AND p.project = ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [query, project];
    } else {
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts ON p.id = user_prompts_fts.rowid
        WHERE user_prompts_fts MATCH ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [query];
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: number;
      session_id: string;
      project: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at,
    }));
  }

  async getTimeline(project?: string, days: number = 30): Promise<TimelineEntry[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffISO = cutoffDate.toISOString();

    let sql: string;
    let params: unknown[];

    if (project) {
      sql = `
        SELECT
          DATE(created_at) as date,
          SUM(token_estimate) as tokens,
          COUNT(*) as observations,
          COUNT(DISTINCT session_id) as sessions
        FROM observations
        WHERE project LIKE ? AND created_at >= ?
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `;
      params = [project + '%', cutoffISO];
    } else {
      sql = `
        SELECT
          DATE(created_at) as date,
          SUM(token_estimate) as tokens,
          COUNT(*) as observations,
          COUNT(DISTINCT session_id) as sessions
        FROM observations
        WHERE created_at >= ?
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `;
      params = [cutoffISO];
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      date: string;
      tokens: number;
      observations: number;
      sessions: number;
    }>;

    return rows;
  }

  async getProjects(): Promise<ProjectEntry[]> {
    const sql = `
      SELECT
        project as path,
        COUNT(*) as observation_count,
        MAX(created_at) as last_activity
      FROM observations
      GROUP BY project
      ORDER BY last_activity DESC
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all() as Array<{
      path: string;
      observation_count: number;
      last_activity: string;
    }>;

    return rows;
  }

  async getSessionObservations(sessionId: string): Promise<Observation[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);

    const rows = stmt.all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async getSessionPrompts(sessionId: string): Promise<UserPrompt[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE session_id = ?
      ORDER BY prompt_number ASC
    `);

    const rows = stmt.all(sessionId) as Array<{
      id: number;
      session_id: string;
      project: string;
      prompt_number: number;
      prompt_text: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at,
    }));
  }

  async countObservations(project?: string, tool?: string): Promise<number> {
    let sql: string;
    const params: unknown[] = [];

    if (project && tool) {
      sql = 'SELECT COUNT(*) as count FROM observations WHERE project LIKE ? AND tool_name = ?';
      params.push(project + '%', tool);
    } else if (project) {
      sql = 'SELECT COUNT(*) as count FROM observations WHERE project LIKE ?';
      params.push(project + '%');
    } else if (tool) {
      sql = 'SELECT COUNT(*) as count FROM observations WHERE tool_name = ?';
      params.push(tool);
    } else {
      sql = 'SELECT COUNT(*) as count FROM observations';
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  async countSessions(project?: string, status?: string): Promise<number> {
    let sql: string;
    const params: unknown[] = [];

    if (project && status) {
      sql = 'SELECT COUNT(*) as count FROM sessions WHERE project LIKE ? AND status = ?';
      params.push(project + '%', status);
    } else if (project) {
      sql = 'SELECT COUNT(*) as count FROM sessions WHERE project LIKE ?';
      params.push(project + '%');
    } else if (status) {
      sql = 'SELECT COUNT(*) as count FROM sessions WHERE status = ?';
      params.push(status);
    } else {
      sql = 'SELECT COUNT(*) as count FROM sessions';
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  async getRelevantCandidates(project: string, limit: number = 200): Promise<Observation[]> {
    // Pre-filter low-importance at SQL level, fetch larger candidate pool
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ? AND importance != 'low'
      ORDER BY importance_score DESC, created_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(project + '%', limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async compactObservations(olderThanDays: number = 7): Promise<{ compacted: number; originals: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffISO = cutoffDate.toISOString();

    // Find groups of 3+ observations with same session + tool, older than cutoff
    // Never compact high-importance or already-compacted observations
    const groups = this.db.prepare(`
      SELECT session_id, tool_name, COUNT(*) as cnt,
             GROUP_CONCAT(id) as ids,
             GROUP_CONCAT(REPLACE(files_touched, ',', ';'), '|') as all_files,
             MIN(created_at) as earliest,
             MAX(created_at) as latest,
             SUM(token_estimate) as total_tokens,
             project
      FROM observations
      WHERE created_at < ?
        AND importance != 'high'
        AND is_compacted = 0
      GROUP BY session_id, tool_name
      HAVING COUNT(*) >= 3
    `).all(cutoffISO) as Array<{
      session_id: string;
      tool_name: string;
      cnt: number;
      ids: string;
      all_files: string;
      earliest: string;
      latest: string;
      total_tokens: number;
      project: string;
    }>;

    let compactedCount = 0;
    let originalsRemoved = 0;

    const insertCompacted = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, tool_name, summary,
        files_touched, metadata, token_estimate,
        importance, importance_score, is_compacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', 0.5, 1, ?)
    `);

    const deleteOriginals = this.db.prepare(`
      DELETE FROM observations WHERE id IN (SELECT value FROM json_each(?))
    `);

    const compact = this.db.transaction(() => {
      for (const group of groups) {
        // Parse all files from the group
        const fileEntries = group.all_files
          .split('|')
          .flatMap(f => {
            try { return JSON.parse(f); }
            catch { return []; }
          })
          .filter((f: string) => f && f.length > 0);
        const uniqueFiles = [...new Set(fileEntries)].slice(0, 10); // Cap at 10

        // Build compact summary
        const summary = `${group.tool_name} x${group.cnt}: ${uniqueFiles.join(', ') || 'various'}`;

        // Token estimate: ~15 tokens for the compact summary
        const tokenEstimate = Math.max(15, Math.ceil(summary.length / 4));

        // Insert compacted observation
        insertCompacted.run(
          group.session_id,
          group.project,
          group.tool_name,
          summary,
          JSON.stringify(uniqueFiles),
          JSON.stringify({ compacted_from: group.cnt, original_tokens: group.total_tokens }),
          tokenEstimate,
          group.earliest
        );

        // Delete originals
        const idList = group.ids.split(',').map(Number);
        deleteOriginals.run(JSON.stringify(idList));

        compactedCount++;
        originalsRemoved += group.cnt;
      }
    });

    compact();

    return { compacted: compactedCount, originals: originalsRemoved };
  }

  close(): void {
    this.db.close();
  }
}
