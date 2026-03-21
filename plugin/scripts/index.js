import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
const __betterSqlite3 = __ctxRequire('better-sqlite3');

// shim:better-sqlite3
var better_sqlite3_default = __betterSqlite3;

// src/storage/sqlite.ts
import { homedir } from "os";
import path from "path";
import { mkdirSync } from "fs";
var DEFAULT_DB_PATH = path.join(homedir(), ".claude-context", "context.db");
var SQLiteStorage = class {
  db;
  constructor(dbPath = DEFAULT_DB_PATH) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new better_sqlite3_default(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("cache_size = -64000");
    this.db.pragma("foreign_keys = ON");
  }
  async initialize() {
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
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_prompts_fts USING fts5(
        prompt_text,
        content=user_prompts,
        content_rowid=id
      );
    `);
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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_created
      ON observations(project, created_at DESC);
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        summary,
        files_touched,
        metadata,
        content=observations,
        content_rowid=id
      );
    `);
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
    this.migrateAddImportanceColumns();
    this.migrateAddExportedAtColumn();
  }
  /**
   * Add importance and compaction columns if they don't exist.
   * Uses pragma table_info to check column existence safely.
   */
  migrateAddImportanceColumns() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("importance")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN importance TEXT DEFAULT 'medium'`);
    }
    if (!columnNames.has("importance_score")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5`);
    }
    if (!columnNames.has("is_compacted")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN is_compacted INTEGER DEFAULT 0`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_score
      ON observations(project, importance_score DESC, created_at DESC)
    `);
  }
  /**
   * Add exported_at column if it doesn't exist.
   */
  migrateAddExportedAtColumn() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("exported_at")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN exported_at TEXT`);
    }
  }
  /**
   * Normalize summary text for dedup comparison.
   * Groups similar observations that differ only in variable query text.
   */
  normalizeSummaryForDedup(summary, toolName) {
    if (summary.includes("psql")) {
      const match = summary.match(/^(Bash:\s*docker\s+exec\s+\S+\s+psql\b)/);
      if (match?.[1])
        return match[1];
      const psqlMatch = summary.match(/^(Bash:\s*psql\b[^|;]*)/);
      if (psqlMatch?.[1])
        return psqlMatch[1].substring(0, 40);
    }
    if (/^Bash:\s*git\s+(status|diff|log)\b/.test(summary)) {
      return summary.substring(0, 20);
    }
    return summary.substring(0, 60);
  }
  /**
   * Map a database row to an Observation object
   */
  mapRow(row) {
    return {
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || void 0,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      token_estimate: row.token_estimate,
      importance: row.importance || "medium",
      importance_score: row.importance_score ?? 0.5,
      is_compacted: row.is_compacted === 1,
      exported_at: row.exported_at || void 0,
      created_at: row.created_at
    };
  }
  async save(observation) {
    const summaryPrefix = this.normalizeSummaryForDedup(observation.summary, observation.tool_name);
    let dedupeWindowMs = 3e5;
    let crossSession = false;
    if (observation.summary.includes("psql")) {
      dedupeWindowMs = 36e5;
      crossSession = true;
    } else if (observation.summary.startsWith("Bash: ssh ")) {
      dedupeWindowMs = 6e5;
      crossSession = true;
    } else if (observation.summary.includes("gh issue") || observation.summary.includes("gh pr")) {
      dedupeWindowMs = 3e5;
      crossSession = true;
    } else if (observation.tool_name === "Read") {
      dedupeWindowMs = 6e5;
      crossSession = false;
    } else if (observation.tool_name === "Grep" || observation.tool_name === "Glob") {
      dedupeWindowMs = 3e5;
      crossSession = false;
    } else if (observation.tool_name === "Edit") {
      dedupeWindowMs = 12e4;
      crossSession = false;
    }
    const windowStart = new Date(Date.now() - dedupeWindowMs).toISOString();
    const prefixLen = summaryPrefix.length;
    const duplicateCheck = crossSession ? this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE project = ?
            AND substr(summary, 1, ?) = ?
            AND created_at > ?
        `) : this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE session_id = ?
            AND substr(summary, 1, ?) = ?
            AND created_at > ?
        `);
    const checkKey = crossSession ? observation.project : observation.session_id;
    const result = duplicateCheck.get(checkKey, prefixLen, summaryPrefix, windowStart);
    if (result.count > 0) {
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
      observation.importance || "medium",
      observation.importance_score ?? 0.5,
      observation.created_at
    );
  }
  async getRecent(project, limit) {
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(project + "%", limit);
    return rows.map((row) => this.mapRow(row));
  }
  async getWithinBudget(project, tokenBudget) {
    const effectiveBudget = Math.floor(tokenBudget * 0.8);
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(project + "%");
    const results = [];
    let totalTokens = 0;
    for (const row of rows) {
      const tokenEstimate = row.token_estimate;
      if (totalTokens + tokenEstimate > effectiveBudget) {
        break;
      }
      results.push(this.mapRow(row));
      totalTokens += tokenEstimate;
    }
    return results;
  }
  async search(query, project) {
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [query, project + "%"];
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
    const rows = stmt.all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  async getStats(project) {
    const TOKEN_BUDGET = parseInt(
      process.env.CONTEXT_MANAGER_TOKEN_BUDGET || "4000",
      10
    );
    const baseSql = project ? `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens,
          AVG(token_estimate) as avg_tokens
        FROM observations
        WHERE project LIKE ? || '%'
      ` : `
        SELECT
          COUNT(*) as total_observations,
          MIN(created_at) as oldest_observation,
          MAX(created_at) as newest_observation,
          SUM(token_estimate) as total_tokens,
          AVG(token_estimate) as avg_tokens
        FROM observations
      `;
    const baseRow = this.db.prepare(baseSql).get(
      ...project ? [project] : []
    );
    const sessionSql = project ? "SELECT COUNT(*) as count FROM sessions WHERE project LIKE ? || '%'" : "SELECT COUNT(*) as count FROM sessions";
    const sessionRow = this.db.prepare(sessionSql).get(
      ...project ? [project] : []
    );
    const toolSql = project ? `
        SELECT tool_name, SUM(token_estimate) as tokens
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY tool_name
        ORDER BY tokens DESC
      ` : `
        SELECT tool_name, SUM(token_estimate) as tokens
        FROM observations
        GROUP BY tool_name
        ORDER BY tokens DESC
      `;
    const toolRows = this.db.prepare(toolSql).all(
      ...project ? [project] : []
    );
    const tokensByTool = {};
    for (const row of toolRows) {
      tokensByTool[row.tool_name] = row.tokens;
    }
    const avgTokensPerSession = sessionRow.count > 0 ? Math.round((baseRow.total_tokens || 0) / sessionRow.count) : 0;
    const recentSql = project ? `
        SELECT SUM(token_estimate) as session_tokens
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC
        LIMIT 10
      ` : `
        SELECT SUM(token_estimate) as session_tokens
        FROM observations
        GROUP BY session_id
        ORDER BY MAX(created_at) DESC
        LIMIT 10
      `;
    const recentRows = this.db.prepare(recentSql).all(
      ...project ? [project] : []
    );
    const avgRecentTokens = recentRows.length > 0 ? Math.round(
      recentRows.reduce((sum, r) => sum + r.session_tokens, 0) / recentRows.length
    ) : 0;
    const typicalInjection = Math.min(avgRecentTokens, TOKEN_BUDGET);
    const importanceSql = project ? `
        SELECT importance, COUNT(*) as cnt
        FROM observations
        WHERE project LIKE ? || '%'
        GROUP BY importance
      ` : `
        SELECT importance, COUNT(*) as cnt
        FROM observations
        GROUP BY importance
      `;
    const importanceRows = this.db.prepare(importanceSql).all(
      ...project ? [project] : []
    );
    const importanceCounts = { high: 0, medium: 0, low: 0 };
    for (const row of importanceRows) {
      const level = row.importance || "medium";
      if (level in importanceCounts) {
        importanceCounts[level] = row.cnt;
      }
    }
    const compactedSql = project ? `
        SELECT
          COUNT(*) as compacted_count,
          COALESCE(SUM(json_extract(metadata, '$.compacted_from')), 0) as original_count
        FROM observations
        WHERE project LIKE ? || '%' AND is_compacted = 1
      ` : `
        SELECT
          COUNT(*) as compacted_count,
          COALESCE(SUM(json_extract(metadata, '$.compacted_from')), 0) as original_count
        FROM observations
        WHERE is_compacted = 1
      `;
    const compactedRow = this.db.prepare(compactedSql).get(
      ...project ? [project] : []
    );
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
      compacted_original_count: compactedRow?.original_count || 0
    };
  }
  async createSession(sessionId, project) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, started_at, status)
      VALUES (?, ?, ?, 'active')
    `);
    stmt.run(sessionId, project, (/* @__PURE__ */ new Date()).toISOString());
  }
  async endSession(sessionId, summary) {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = ?, status = 'complete'
      WHERE id = ?
    `);
    stmt.run((/* @__PURE__ */ new Date()).toISOString(), summary || null, sessionId);
  }
  async getRecentSessions(project, limit) {
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
    const rows = stmt.all(project, limit);
    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || void 0,
      summary: row.summary || void 0,
      status: row.status
    }));
  }
  async vacuum(olderThanDays) {
    let deletedObservations = 0;
    if (olderThanDays) {
      const cutoffDate = /* @__PURE__ */ new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();
      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?
      `);
      const result = stmt.run(cutoffISO);
      deletedObservations = result.changes;
    }
    const compactionResult = await this.compactObservations(7);
    const orphanStmt = this.db.prepare(`
      DELETE FROM sessions
      WHERE id NOT IN (SELECT DISTINCT session_id FROM observations)
        AND id NOT IN (SELECT DISTINCT session_id FROM user_prompts)
    `);
    const orphanResult = orphanStmt.run();
    const deletedSessions = orphanResult.changes;
    this.db.exec("ANALYZE");
    this.db.exec("VACUUM");
    return {
      observations: deletedObservations,
      sessions: deletedSessions,
      compacted: compactionResult.compacted,
      compacted_originals: compactionResult.originals
    };
  }
  async saveUserPrompt(prompt) {
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
  async getRecentPrompts(project, limit) {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(project, limit);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at
    }));
  }
  async searchPrompts(query, project) {
    let sql;
    let params;
    if (project) {
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
    const rows = stmt.all(...params);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at
    }));
  }
  async getTimeline(project, days = 30) {
    const cutoffDate = /* @__PURE__ */ new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffISO = cutoffDate.toISOString();
    let sql;
    let params;
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
      params = [project + "%", cutoffISO];
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
    const rows = stmt.all(...params);
    return rows;
  }
  async getProjects() {
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
    const rows = stmt.all();
    return rows;
  }
  async getSessionObservations(sessionId) {
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(sessionId);
    return rows.map((row) => this.mapRow(row));
  }
  async getSessionPrompts(sessionId) {
    const stmt = this.db.prepare(`
      SELECT * FROM user_prompts
      WHERE session_id = ?
      ORDER BY prompt_number ASC
    `);
    const rows = stmt.all(sessionId);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      prompt_number: row.prompt_number,
      prompt_text: row.prompt_text,
      created_at: row.created_at
    }));
  }
  async countObservations(project, tool) {
    let sql;
    const params = [];
    if (project && tool) {
      sql = "SELECT COUNT(*) as count FROM observations WHERE project LIKE ? AND tool_name = ?";
      params.push(project + "%", tool);
    } else if (project) {
      sql = "SELECT COUNT(*) as count FROM observations WHERE project LIKE ?";
      params.push(project + "%");
    } else if (tool) {
      sql = "SELECT COUNT(*) as count FROM observations WHERE tool_name = ?";
      params.push(tool);
    } else {
      sql = "SELECT COUNT(*) as count FROM observations";
    }
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params);
    return result.count;
  }
  async countSessions(project, status) {
    let sql;
    const params = [];
    if (project && status) {
      sql = "SELECT COUNT(*) as count FROM sessions WHERE project LIKE ? AND status = ?";
      params.push(project + "%", status);
    } else if (project) {
      sql = "SELECT COUNT(*) as count FROM sessions WHERE project LIKE ?";
      params.push(project + "%");
    } else if (status) {
      sql = "SELECT COUNT(*) as count FROM sessions WHERE status = ?";
      params.push(status);
    } else {
      sql = "SELECT COUNT(*) as count FROM sessions";
    }
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params);
    return result.count;
  }
  async getRelevantCandidates(project, limit = 200) {
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ? AND importance != 'low'
      ORDER BY importance_score DESC, created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(project + "%", limit);
    return rows.map((row) => this.mapRow(row));
  }
  async compactObservations(olderThanDays = 7) {
    const cutoffDate = /* @__PURE__ */ new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    const cutoffISO = cutoffDate.toISOString();
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
    `).all(cutoffISO);
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
        const fileEntries = group.all_files.split("|").flatMap((f) => {
          try {
            return JSON.parse(f);
          } catch {
            return [];
          }
        }).filter((f) => f && f.length > 0);
        const uniqueFiles = [...new Set(fileEntries)].slice(0, 10);
        const summary = `${group.tool_name} x${group.cnt}: ${uniqueFiles.join(", ") || "various"}`;
        const tokenEstimate = Math.max(15, Math.ceil(summary.length / 4));
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
        const idList = group.ids.split(",").map(Number);
        deleteOriginals.run(JSON.stringify(idList));
        compactedCount++;
        originalsRemoved += group.cnt;
      }
    });
    compact();
    return { compacted: compactedCount, originals: originalsRemoved };
  }
  async getUnexportedHighImportance(project, sessionId, minScore = 0.65) {
    let sql;
    let params;
    if (sessionId) {
      sql = `
        SELECT * FROM observations
        WHERE project LIKE ? AND session_id = ?
          AND importance_score >= ? AND exported_at IS NULL
        ORDER BY created_at ASC
      `;
      params = [project + "%", sessionId, minScore];
    } else {
      sql = `
        SELECT * FROM observations
        WHERE project LIKE ?
          AND importance_score >= ? AND exported_at IS NULL
        ORDER BY created_at ASC
      `;
      params = [project + "%", minScore];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  async markExported(ids) {
    if (ids.length === 0)
      return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const stmt = this.db.prepare(
      `UPDATE observations SET exported_at = ? WHERE id IN (SELECT value FROM json_each(?))`
    );
    stmt.run(now, JSON.stringify(ids));
  }
  close() {
    this.db.close();
  }
};

// src/export/memory.ts
import { mkdirSync as mkdirSync2, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir as homedir2 } from "os";

// src/utils/transcript.ts
function convertPathToDashed(projectPath) {
  return projectPath.replace(/\//g, "-");
}

// src/export/memory.ts
var TOPIC_FILE = "context-manager-activity.md";
var DEFAULT_MAX_LINES = 150;
function resolveMemoryDir(projectPath) {
  const dashedPath = convertPathToDashed(projectPath);
  return join(homedir2(), ".claude", "projects", dashedPath, "memory");
}
function formatObservationsForMemory(observations) {
  if (observations.length === 0)
    return "";
  const byDate = /* @__PURE__ */ new Map();
  for (const obs of observations) {
    const date = obs.created_at.split("T")[0] ?? "unknown";
    if (!byDate.has(date))
      byDate.set(date, /* @__PURE__ */ new Map());
    const dateGroup = byDate.get(date);
    if (!dateGroup.has(obs.session_id))
      dateGroup.set(obs.session_id, []);
    dateGroup.get(obs.session_id).push(obs);
  }
  const lines = [];
  for (const [date, sessions] of byDate) {
    lines.push(`## ${date}`);
    lines.push("");
    for (const [sessionId, sessionObs] of sessions) {
      const shortId = sessionId.substring(0, 8);
      const first = sessionObs[0];
      const last = sessionObs[sessionObs.length - 1];
      const startTime = first.created_at.split("T")[1]?.substring(0, 5) ?? "";
      const endTime = last.created_at.split("T")[1]?.substring(0, 5) ?? "";
      lines.push(`### Session ${shortId} (${startTime} - ${endTime})`);
      for (const obs of sessionObs) {
        lines.push(`- ${formatObservationLine(obs)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
function formatObservationLine(obs) {
  const file = obs.files_touched[0] || "";
  const shortFile = file ? file.split("/").slice(-2).join("/") : "";
  switch (obs.tool_name) {
    case "Edit":
      return `**Edited** ${shortFile}${extractDetail(obs)}`;
    case "Write":
      return `**Created** ${shortFile}${extractDetail(obs)}`;
    case "Bash": {
      if (obs.summary.includes("git commit")) {
        const msg = obs.summary.match(/commit -m ["'](.+?)["']/)?.[1] || obs.summary.match(/"([^"]+)"/)?.[1] || "";
        return `**Git commit** \u2014 "${msg.substring(0, 80)}"`;
      }
      if (obs.summary.includes("git push"))
        return `**Git push** \u2014 ${obs.summary.substring(0, 80)}`;
      return `**Ran** ${obs.summary.substring(0, 80)}`;
    }
    case "Read":
      return `**Read** ${shortFile}`;
    default:
      return `**${obs.tool_name}** ${obs.summary.substring(0, 80)}`;
  }
}
function extractDetail(obs) {
  const summary = obs.summary;
  const dashIndex = summary.indexOf(" \u2014 ");
  if (dashIndex > 0) {
    return ` \u2014 ${summary.substring(dashIndex + 3, dashIndex + 83)}`;
  }
  const colonIndex = summary.indexOf(": ");
  if (colonIndex > 0 && colonIndex < 60) {
    return ` \u2014 ${summary.substring(colonIndex + 2, colonIndex + 82)}`;
  }
  return "";
}
function writeActivityToMemory(projectPath, newContent, maxLines = DEFAULT_MAX_LINES) {
  const memoryDir = resolveMemoryDir(projectPath);
  mkdirSync2(memoryDir, { recursive: true });
  const filePath = join(memoryDir, TOPIC_FILE);
  const header = [
    "# Project Activity Log",
    "",
    `> Auto-generated by context-manager. Updated ${(/* @__PURE__ */ new Date()).toISOString()}.`,
    "> Use context_search MCP tool for full history search.",
    ""
  ].join("\n");
  let existingBody = "";
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    const bodyMatch = existing.match(/^(## .+)/m);
    if (bodyMatch?.index !== void 0) {
      existingBody = existing.substring(bodyMatch.index);
    }
  }
  const fullBody = existingBody ? existingBody.trimEnd() + "\n\n" + newContent.trimEnd() : newContent.trimEnd();
  const bodyLines = fullBody.split("\n");
  const trimmedBody = bodyLines.length > maxLines ? bodyLines.slice(bodyLines.length - maxLines).join("\n") : fullBody;
  const finalContent = header + trimmedBody + "\n";
  writeFileSync(filePath, finalContent);
  return { filePath, linesWritten: trimmedBody.split("\n").length };
}
async function exportToAutoMemory(storage2, projectPath, sessionId) {
  const observations = await storage2.getUnexportedHighImportance(
    projectPath,
    sessionId
  );
  if (observations.length === 0) {
    return { exported: 0, filePath: null };
  }
  const formatted = formatObservationsForMemory(observations);
  const { filePath } = writeActivityToMemory(projectPath, formatted);
  const ids = observations.map((o) => o.id).filter((id) => id !== void 0);
  if (ids.length > 0) {
    await storage2.markExported(ids);
  }
  return { exported: observations.length, filePath };
}

// cli/index.ts
var storage = new SQLiteStorage();
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  try {
    await storage.initialize();
    switch (command) {
      case "list":
        await listCommand(args.slice(1));
        break;
      case "search":
        await searchCommand(args.slice(1));
        break;
      case "stats":
        await statsCommand(args.slice(1));
        break;
      case "vacuum":
        await vacuumCommand(args.slice(1));
        break;
      case "export":
        await exportCommand(args.slice(1));
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    storage.close();
  }
}
async function listCommand(args) {
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 20;
  const projectIndex = args.indexOf("--project");
  let project;
  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith("-")) {
      console.error("Error: --project requires a path argument");
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = process.cwd();
  }
  const observations = await storage.getRecent(project, limit);
  if (observations.length === 0) {
    console.log("No observations found.");
    return;
  }
  console.log(`
Recent observations for ${project}:
`);
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const date = new Date(obs.created_at);
    const fileInfo = obs.files_touched.length > 0 ? ` (${obs.files_touched.join(", ")})` : "";
    console.log(
      `${i + 1}. [${date.toISOString()}] ${obs.summary}${fileInfo}`
    );
    console.log(`   Tool: ${obs.tool_name}, Tokens: ${obs.token_estimate}`);
    console.log();
  }
}
async function searchCommand(args) {
  if (args.length === 0) {
    console.error("Usage: context-manager search <query> [--project <path>]");
    process.exit(1);
  }
  const projectIndex = args.indexOf("--project");
  let project;
  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith("-")) {
      console.error("Error: --project requires a path argument");
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = void 0;
  }
  const queryArgs = args.filter(
    (arg, idx) => arg !== "--project" && (idx === 0 || args[idx - 1] !== "--project")
  );
  const query = queryArgs.join(" ");
  const observations = await storage.search(query, project);
  if (observations.length === 0) {
    console.log("No observations found matching query.");
    return;
  }
  console.log(
    `
Found ${observations.length} observations matching "${query}":
`
  );
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const date = new Date(obs.created_at);
    const fileInfo = obs.files_touched.length > 0 ? ` (${obs.files_touched.join(", ")})` : "";
    console.log(
      `${i + 1}. [${date.toISOString()}] ${obs.summary}${fileInfo}`
    );
    console.log(`   Project: ${obs.project}`);
    console.log();
  }
}
async function statsCommand(args) {
  const projectIndex = args.indexOf("--project");
  let project;
  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith("-")) {
      console.error("Error: --project requires a path argument");
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = void 0;
  }
  const stats = await storage.getStats(project);
  console.log("\nContext Manager Statistics\n");
  if (project) {
    console.log(`Project: ${project}
`);
  } else {
    console.log("All Projects\n");
  }
  console.log("=== Storage ===");
  console.log(`Total Observations: ${stats.total_observations}`);
  console.log(`Total Sessions: ${stats.total_sessions}`);
  console.log(`Date Range: ${stats.oldest_observation || "N/A"} to ${stats.newest_observation || "N/A"}`);
  console.log("\n=== Token Economics ===");
  console.log(`Total Tokens Stored: ${stats.total_tokens.toLocaleString()}`);
  console.log(`Avg per Observation: ${stats.avg_tokens_per_observation} tokens`);
  console.log(`Avg per Session: ${stats.avg_tokens_per_session.toLocaleString()} tokens`);
  console.log(`Injection Budget: ${stats.token_budget.toLocaleString()} tokens`);
  console.log(`Typical Injection: ~${stats.typical_injection_tokens.toLocaleString()} tokens (${Math.round(stats.typical_injection_tokens / stats.token_budget * 100)}% of budget)`);
  if (Object.keys(stats.tokens_by_tool).length > 0) {
    console.log("\n=== Tokens by Tool ===");
    const tools = Object.entries(stats.tokens_by_tool).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tool, tokens] of tools) {
      const pct = Math.round(tokens / stats.total_tokens * 100);
      console.log(`  ${tool}: ${tokens.toLocaleString()} (${pct}%)`);
    }
  }
  const imp = stats.importance_counts;
  const impTotal = imp.high + imp.medium + imp.low;
  if (impTotal > 0) {
    console.log("\n=== Importance Distribution ===");
    const pctH = Math.round(imp.high / impTotal * 100);
    const pctM = Math.round(imp.medium / impTotal * 100);
    const pctL = Math.round(imp.low / impTotal * 100);
    console.log(`  High:   ${imp.high.toLocaleString()} (${pctH}%)`);
    console.log(`  Medium: ${imp.medium.toLocaleString()} (${pctM}%)`);
    console.log(`  Low:    ${imp.low.toLocaleString()} (${pctL}%)`);
  }
  if (stats.compacted_count > 0) {
    console.log("\n=== Compaction ===");
    console.log(`  Compacted: ${stats.compacted_count} observations (from ${stats.compacted_original_count} originals)`);
  }
}
async function vacuumCommand(args) {
  const daysIndex = args.indexOf("--days");
  const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1], 10) : void 0;
  if (days) {
    console.log(`Deleting observations older than ${days} days...`);
  }
  console.log("Cleaning up orphaned sessions and optimizing database...");
  const result = await storage.vacuum(days);
  if (days) {
    console.log(`Deleted ${result.observations} observations.`);
  }
  if (result.compacted > 0) {
    console.log(`Compacted ${result.compacted_originals} observations into ${result.compacted} summaries.`);
  }
  if (result.sessions > 0) {
    console.log(`Cleaned up ${result.sessions} orphaned sessions.`);
  }
  console.log("Database optimized.");
}
async function exportCommand(args) {
  const projectIndex = args.indexOf("--project");
  let project;
  if (projectIndex !== -1) {
    const providedPath = args[projectIndex + 1];
    if (!providedPath || providedPath.startsWith("-")) {
      console.error("Error: --project requires a path argument");
      process.exit(1);
    }
    project = providedPath;
  } else {
    project = process.cwd();
  }
  const dryRun = args.includes("--dry-run");
  const observations = await storage.getUnexportedHighImportance(project);
  if (observations.length === 0) {
    console.log("No unexported high-importance observations found.");
    return;
  }
  console.log(`
Found ${observations.length} unexported high-importance observations for ${project}:
`);
  for (const obs of observations.slice(0, 20)) {
    const date = new Date(obs.created_at);
    const fileInfo = obs.files_touched[0] ? ` (${obs.files_touched[0]})` : "";
    console.log(`  [${date.toISOString()}] ${obs.tool_name}: ${obs.summary.substring(0, 80)}${fileInfo}`);
  }
  if (observations.length > 20) {
    console.log(`  ... and ${observations.length - 20} more`);
  }
  if (dryRun) {
    console.log("\n--- Dry run: formatted output ---\n");
    const formatted = formatObservationsForMemory(observations);
    console.log(formatted);
    console.log(`
Target: ${resolveMemoryDir(project)}/context-manager-activity.md`);
    console.log("(dry run \u2014 no files written)");
    return;
  }
  const result = await exportToAutoMemory(storage, project);
  console.log(`
Exported ${result.exported} observations to auto-memory.`);
  if (result.filePath) {
    console.log(`Topic file: ${result.filePath}`);
  }
}
function printHelp() {
  console.log(`
claude-context-manager CLI

Usage:
  context-manager <command> [options]

Commands:
  list [--limit N] [--project PATH]
    List recent observations (default: 20)

  search <query> [--project PATH]
    Full-text search observations

  stats [--project PATH]
    Show statistics

  vacuum [--days N]
    Delete observations older than N days, or reclaim disk space

  export [--project PATH] [--dry-run]
    Export high-importance observations to auto-memory topic file

  help
    Show this help message

Examples:
  context-manager list --limit 10
  context-manager search "authentication" --project ~/Projects/my-app
  context-manager stats --project ~/Projects/my-app
  context-manager vacuum --days 30
  context-manager export --dry-run
`);
}
main();
