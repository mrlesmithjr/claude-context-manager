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
  Session,
  Stats,
  UserPrompt,
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
  }

  async save(observation: Omit<Observation, 'id'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, package, tool_name, summary,
        files_touched, metadata, token_estimate, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const rows = stmt.all(project + '%', limit) as Array<{
      id: number;
      session_id: string;
      project: string;
      package: string | null;
      tool_name: string;
      summary: string;
      files_touched: string;
      metadata: string;
      token_estimate: number;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || undefined,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      token_estimate: row.token_estimate,
      created_at: row.created_at,
    }));
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

    const rows = stmt.all(project + '%') as Array<{
      id: number;
      session_id: string;
      project: string;
      package: string | null;
      tool_name: string;
      summary: string;
      files_touched: string;
      metadata: string;
      token_estimate: number;
      created_at: string;
    }>;

    // Accumulate observations until budget exceeded
    const results: Observation[] = [];
    let totalTokens = 0;

    for (const row of rows) {
      if (totalTokens + row.token_estimate > effectiveBudget) {
        break;
      }

      results.push({
        id: row.id,
        session_id: row.session_id,
        project: row.project,
        package: row.package || undefined,
        tool_name: row.tool_name,
        summary: row.summary,
        files_touched: JSON.parse(row.files_touched || '[]'),
        metadata: JSON.parse(row.metadata || '{}'),
        token_estimate: row.token_estimate,
        created_at: row.created_at,
      });

      totalTokens += row.token_estimate;
    }

    return results;
  }

  async search(query: string, project?: string): Promise<Observation[]> {
    let sql: string;
    let params: unknown[];

    if (project) {
      // Use LIKE for prefix matching (parent directory sees children)
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts fts ON o.id = fts.rowid
        WHERE fts MATCH ? AND o.project LIKE ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [query, project + '%'];
    } else {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts fts ON o.id = fts.rowid
        WHERE fts MATCH ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [query];
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: number;
      session_id: string;
      project: string;
      package: string | null;
      tool_name: string;
      summary: string;
      files_touched: string;
      metadata: string;
      token_estimate: number;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || undefined,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      token_estimate: row.token_estimate,
      created_at: row.created_at,
    }));
  }

  async getStats(project?: string): Promise<Stats> {
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens
        FROM observations
        WHERE project = ?
      `;
      params = [project];
    } else {
      sql = `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens
        FROM observations
      `;
      params = [];
    }

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as {
      total_observations: number;
      oldest_observation: string | null;
      newest_observation: string | null;
      total_tokens: number | null;
    };

    const sessionStmt = project
      ? this.db.prepare('SELECT COUNT(*) as count FROM sessions WHERE project = ?')
      : this.db.prepare('SELECT COUNT(*) as count FROM sessions');

    const sessionRow = sessionStmt.get(
      ...(project ? [project] : [])
    ) as { count: number };

    return {
      total_observations: row.total_observations,
      total_sessions: sessionRow.count,
      oldest_observation: row.oldest_observation,
      newest_observation: row.newest_observation,
      total_tokens: row.total_tokens || 0,
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
    // Prioritize complete sessions over active sessions, then sort by recency
    // This ensures getPreviouslyContext finds completed sessions even if there are many active ones
    const stmt = this.db.prepare(`
      SELECT * FROM sessions
      WHERE project = ?
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

  async vacuum(olderThanDays?: number): Promise<number> {
    if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();

      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?
      `);

      const result = stmt.run(cutoffISO);
      return result.changes;
    }

    // If no days specified, just run VACUUM to reclaim space
    this.db.exec('VACUUM');
    return 0;
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
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts fts ON p.id = fts.rowid
        WHERE fts MATCH ? AND p.project = ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [query, project];
    } else {
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts fts ON p.id = fts.rowid
        WHERE fts MATCH ?
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

  close(): void {
    this.db.close();
  }
}
