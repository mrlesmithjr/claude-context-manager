#!/usr/bin/env node
import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
const __betterSqlite3 = __ctxRequire('better-sqlite3');
const __sqliteVec = __ctxRequire('sqlite-vec');

// shim:better-sqlite3
var better_sqlite3_default = __betterSqlite3;

// src/storage/sqlite.ts
import { homedir } from "os";
import path from "path";
import { mkdirSync } from "fs";

// shim:sqlite-vec
var load = __sqliteVec.load;
var sqlite_vec_default = __sqliteVec;

// src/utils/hash.ts
import { createHash } from "crypto";
function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
function l2DistanceToCosine(l2Distance) {
  return Math.max(0, Math.min(1, 1 - l2Distance * l2Distance / 2));
}

// src/storage/sqlite.ts
var DEFAULT_DB_PATH = path.join(homedir(), ".claude-context", "context.db");
var SQLiteStorage = class {
  db;
  vecEnabled = false;
  constructor(dbPath = DEFAULT_DB_PATH) {
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    this.db = new better_sqlite3_default(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("cache_size = -64000");
    this.db.pragma("foreign_keys = ON");
    try {
      load(this.db);
      this.vecEnabled = true;
    } catch {
      this.vecEnabled = false;
    }
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
    this.migrateAddVectorSearch();
    this.migrateAddSessionVectorSearch();
    this.migrateAddFileEncounterCounts();
    this.migrateAddObservationRelationships();
    this.migrateAddTagsColumn();
    this.migrateAddContentHash();
    this.migrateAddSummaryExtended();
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
      tags: row.tags ? row.tags.split(",").filter(Boolean) : void 0,
      content_hash: row.content_hash || void 0,
      created_at: row.created_at
    };
  }
  async save(observation) {
    const storedOutput = typeof observation.metadata?.stored_output === "string" ? observation.metadata.stored_output : "";
    const hashInput = `${observation.summary}
${JSON.stringify(observation.files_touched)}
${storedOutput}`;
    const contentHash = sha256(hashInput);
    const hashCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM observations
      WHERE project LIKE ? AND content_hash = ?
    `).get(observation.project + "%", contentHash);
    if (hashCheck.count > 0) {
      return void 0;
    }
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
      return void 0;
    }
    const stmt = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, package, tool_name, summary,
        files_touched, metadata, token_estimate,
        importance, importance_score, tags, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tagsValue = observation.tags && observation.tags.length > 0 ? observation.tags.join(",") : null;
    const info = stmt.run(
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
      tagsValue,
      contentHash,
      observation.created_at
    );
    const insertedId = Number(info.lastInsertRowid);
    this.inferRelationships(insertedId, observation);
    return insertedId;
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
      ORDER BY importance_score DESC, created_at DESC
      LIMIT 500
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
    const ftsQuery = query.replace(/"/g, '""').split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t}"`).join(" ");
    if (project) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [ftsQuery, project + "%"];
    } else {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY o.created_at DESC
        LIMIT 50
      `;
      params = [ftsQuery];
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  async searchByTag(tag, project, limit = 50) {
    const likePattern = `%,${tag},%`;
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT * FROM observations
        WHERE tags IS NOT NULL AND ',' || tags || ',' LIKE ? AND project LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [likePattern, project + "%", limit];
    } else {
      sql = `
        SELECT * FROM observations
        WHERE tags IS NOT NULL AND ',' || tags || ',' LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [likePattern, limit];
    }
    const rows = this.db.prepare(sql).all(...params);
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
  async endSession(sessionId, summary, summaryExtended) {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = ?, summary_extended = ?, status = 'complete'
      WHERE id = ?
    `);
    stmt.run((/* @__PURE__ */ new Date()).toISOString(), summary || null, summaryExtended || null, sessionId);
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
      summary_extended: row.summary_extended || void 0,
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
    this.db.prepare(`
      DELETE FROM observations
      WHERE session_id NOT IN (SELECT id FROM sessions)
    `).run();
    const compactionResult = await this.compactObservations(7);
    this.db.prepare(`
      DELETE FROM user_prompts
      WHERE session_id IN (
        SELECT id FROM sessions
        WHERE ended_at IS NULL
          AND started_at < datetime('now', '-1 day')
          AND id NOT IN (SELECT DISTINCT session_id FROM observations)
      )
    `).run();
    const ghostResult = this.db.prepare(`
      DELETE FROM sessions
      WHERE ended_at IS NULL
        AND started_at < datetime('now', '-1 day')
        AND id NOT IN (SELECT DISTINCT session_id FROM observations)
    `).run();
    const deletedGhostSessions = ghostResult.changes;
    this.db.prepare(`
      DELETE FROM user_prompts
      WHERE session_id NOT IN (SELECT DISTINCT session_id FROM observations)
    `).run();
    const orphanStmt = this.db.prepare(`
      DELETE FROM sessions
      WHERE id NOT IN (SELECT DISTINCT session_id FROM observations)
        AND id NOT IN (SELECT DISTINCT session_id FROM user_prompts)
    `);
    const orphanResult = orphanStmt.run();
    const deletedSessions = orphanResult.changes + deletedGhostSessions;
    this.db.pragma("foreign_keys = OFF");
    this.db.exec("ANALYZE");
    this.db.exec("VACUUM");
    this.db.pragma("foreign_keys = ON");
    return {
      observations: deletedObservations,
      sessions: deletedSessions,
      compacted: compactionResult.compacted,
      compacted_originals: compactionResult.originals
    };
  }
  async prune(options) {
    const { toolName, importance, olderThanDays, dryRun = false } = options;
    const conditions = [];
    const params = [];
    if (olderThanDays !== void 0) {
      const cutoff = /* @__PURE__ */ new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      conditions.push("created_at < ?");
      params.push(cutoff.toISOString());
    }
    if (toolName) {
      conditions.push("tool_name = ?");
      params.push(toolName);
    }
    if (importance) {
      conditions.push("importance = ?");
      params.push(importance);
    }
    if (conditions.length === 0) {
      return { deleted: 0 };
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    if (dryRun) {
      const total = this.db.prepare(`SELECT COUNT(*) as cnt FROM observations ${where}`).get(...params).cnt;
      const rows = this.db.prepare(
        `SELECT tool_name, importance, summary FROM observations ${where} ORDER BY created_at DESC LIMIT 5`
      ).all(...params);
      const preview = rows.map((r) => `[${r.importance}] ${r.tool_name}: ${r.summary.slice(0, 80)}`);
      return { deleted: total, preview };
    }
    const ids = this.db.prepare(`SELECT id FROM observations ${where}`).all(...params).map((r) => r.id);
    if (ids.length === 0) {
      return { deleted: 0 };
    }
    if (this.vecEnabled) {
      const idJson = JSON.stringify(ids);
      this.db.prepare(
        `DELETE FROM vec_observations WHERE observation_id IN (SELECT value FROM json_each(?))`
      ).run(idJson);
    }
    const result = this.db.prepare(`DELETE FROM observations ${where}`).run(...params);
    return { deleted: result.changes };
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
    const ftsQuery = query.replace(/"/g, '""').split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t}"`).join(" ");
    if (project) {
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts ON p.id = user_prompts_fts.rowid
        WHERE user_prompts_fts MATCH ? AND p.project LIKE ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [ftsQuery, project + "%"];
    } else {
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts ON p.id = user_prompts_fts.rowid
        WHERE user_prompts_fts MATCH ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [ftsQuery];
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
    const deleteVec = this.vecEnabled ? this.db.prepare(
      `DELETE FROM vec_observations WHERE observation_id IN (SELECT value FROM json_each(?))`
    ) : null;
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
        if (deleteVec) {
          deleteVec.run(JSON.stringify(idList));
        }
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
  /**
   * Migration: add embedding column and vec0 virtual table for vector search.
   * Only creates the vec0 table if sqlite-vec loaded successfully.
   */
  migrateAddVectorSearch() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("embedding")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN embedding BLOB`);
    }
    if (!this.vecEnabled)
      return;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
          observation_id INTEGER PRIMARY KEY,
          embedding float[384]
        )
      `);
    } catch {
      this.vecEnabled = false;
    }
  }
  isVectorSearchEnabled() {
    return this.vecEnabled;
  }
  /**
   * Layer 2 semantic dedup: cosine similarity check against already-embedded corpus.
   * Only runs when sqlite-vec is enabled. Returns true if a near-duplicate exists.
   *
   * Runs at embed time (not capture time) to avoid loading the model in the hook process.
   * When a near-duplicate is detected, the caller demotes importance rather than deleting,
   * preserving relational integrity (observation_relationships may reference this row).
   */
  checkSemanticDuplicate(embedding, project, id, threshold = 0.85) {
    if (!this.vecEnabled)
      return false;
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const row = this.db.prepare(`
      SELECT v.distance
      FROM vec_observations v
      INNER JOIN observations o ON o.id = v.observation_id
      WHERE v.embedding MATCH ? AND k = ?
        AND o.project LIKE ?
        AND v.observation_id != CAST(? AS INTEGER)
      ORDER BY v.distance ASC
      LIMIT 1
    `).get(embeddingBuf, 10, project + "%", id);
    if (!row)
      return false;
    return l2DistanceToCosine(row.distance) >= threshold;
  }
  async saveEmbedding(id, embedding) {
    if (!this.vecEnabled) {
      throw new Error("Vector search is not enabled (sqlite-vec not loaded)");
    }
    const obs = this.db.prepare(
      `SELECT project FROM observations WHERE id = ?`
    ).get(id);
    if (obs && this.checkSemanticDuplicate(embedding, obs.project, id)) {
      this.db.prepare(
        `UPDATE observations SET importance = 'low', importance_score = 0.05 WHERE id = ?`
      ).run(id);
    }
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const saveTransaction = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE observations SET embedding = ? WHERE id = ?`
      ).run(embeddingBuf, id);
      this.db.prepare(
        `INSERT OR REPLACE INTO vec_observations (observation_id, embedding) VALUES (CAST(? AS INTEGER), ?)`
      ).run(id, embeddingBuf);
    });
    saveTransaction();
  }
  async vectorSearch(embedding, project, topK = 10) {
    if (!this.vecEnabled) {
      throw new Error("Vector search is not enabled (sqlite-vec not loaded)");
    }
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT o.*, v.distance
        FROM vec_observations v
        INNER JOIN observations o ON o.id = v.observation_id
        WHERE v.embedding MATCH ? AND k = ?
          AND o.project LIKE ?
        ORDER BY v.distance ASC
      `;
      params = [embeddingBuf, topK, project + "%"];
    } else {
      sql = `
        SELECT o.*, v.distance
        FROM vec_observations v
        INNER JOIN observations o ON o.id = v.observation_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance ASC
      `;
      params = [embeddingBuf, topK];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      const obs = this.mapRow(row);
      const distance = row.distance;
      if (distance != null) {
        obs.similarity_score = l2DistanceToCosine(distance);
      }
      return obs;
    });
  }
  /**
   * Count observations missing embeddings (efficient SQL COUNT)
   */
  countUnembedded(project) {
    const sql = project ? `SELECT COUNT(*) as count FROM observations WHERE embedding IS NULL AND project LIKE ?` : `SELECT COUNT(*) as count FROM observations WHERE embedding IS NULL`;
    const row = project ? this.db.prepare(sql).get(project + "%") : this.db.prepare(sql).get();
    return row.count;
  }
  /**
   * Migration: add embedding column and vec0 virtual table for session-level vector search.
   * Sessions get enriched text embeddings (user prompts + actions + summary).
   */
  migrateAddSessionVectorSearch() {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("embedding")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN embedding BLOB`);
    }
    if (!columnNames.has("enriched_text")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN enriched_text TEXT`);
    }
    if (!this.vecEnabled)
      return;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_sessions USING vec0(
          session_id TEXT PRIMARY KEY,
          embedding float[384]
        )
      `);
    } catch {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_sessions USING vec0(
            session_rowid INTEGER PRIMARY KEY,
            embedding float[384]
          )
        `);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS vec_sessions_map (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE NOT NULL
          )
        `);
      } catch {
      }
    }
  }
  /**
   * Migration: add file_encounter_counts table for surprise scoring.
   */
  migrateAddFileEncounterCounts() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_encounter_counts (
        file_path TEXT NOT NULL,
        project TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        encounter_count INTEGER DEFAULT 0,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (file_path, project, tool_name)
      )
    `);
  }
  /**
   * Migration: add observation_relationships table for linking related observations.
   */
  migrateAddObservationRelationships() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observation_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        relationship TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES observations(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES observations(id) ON DELETE CASCADE
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_rel_source ON observation_relationships(source_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_obs_rel_target ON observation_relationships(target_id)`);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_rel_unique
      ON observation_relationships(source_id, target_id, relationship)
    `);
  }
  /**
   * Migration: add tags column to observations for domain classification.
   */
  migrateAddTagsColumn() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("tags")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN tags TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_tags
      ON observations(tags) WHERE tags IS NOT NULL
    `);
  }
  /**
   * Migration: add content_hash column for SHA256-based exact deduplication.
   * Partial index scoped by project keeps hash lookups fast without scanning NULLs.
   */
  migrateAddContentHash() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("content_hash")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN content_hash TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_hash
      ON observations(project, content_hash) WHERE content_hash IS NOT NULL
    `);
  }
  migrateAddSummaryExtended() {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("summary_extended")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN summary_extended TEXT`);
    }
  }
  async saveSessionEmbedding(sessionId, embedding, enrichedText) {
    if (!this.vecEnabled) {
      throw new Error("Vector search is not enabled (sqlite-vec not loaded)");
    }
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const saveTransaction = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE sessions SET embedding = ?, enriched_text = ? WHERE id = ?`
      ).run(embeddingBuf, enrichedText, sessionId);
      try {
        this.db.prepare(
          `INSERT OR REPLACE INTO vec_sessions (session_id, embedding) VALUES (?, ?)`
        ).run(sessionId, embeddingBuf);
      } catch {
        this.db.prepare(
          `INSERT OR IGNORE INTO vec_sessions_map (session_id) VALUES (?)`
        ).run(sessionId);
        const mapRow = this.db.prepare(
          `SELECT rowid FROM vec_sessions_map WHERE session_id = ?`
        ).get(sessionId);
        if (mapRow) {
          this.db.prepare(
            `INSERT OR REPLACE INTO vec_sessions (session_rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`
          ).run(mapRow.rowid, embeddingBuf);
        }
      }
    });
    saveTransaction();
  }
  async vectorSearchSessions(embedding, project, topK = 10) {
    if (!this.vecEnabled) {
      throw new Error("Vector search is not enabled (sqlite-vec not loaded)");
    }
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    let rows;
    try {
      let sql;
      let params;
      if (project) {
        sql = `
          SELECT s.*, v.distance
          FROM vec_sessions v
          INNER JOIN sessions s ON s.id = v.session_id
          WHERE v.embedding MATCH ? AND k = ?
            AND s.project LIKE ?
          ORDER BY v.distance ASC
        `;
        params = [embeddingBuf, topK, project + "%"];
      } else {
        sql = `
          SELECT s.*, v.distance
          FROM vec_sessions v
          INNER JOIN sessions s ON s.id = v.session_id
          WHERE v.embedding MATCH ? AND k = ?
          ORDER BY v.distance ASC
        `;
        params = [embeddingBuf, topK];
      }
      rows = this.db.prepare(sql).all(...params);
    } catch {
      let sql;
      let params;
      if (project) {
        sql = `
          SELECT s.*, v.distance
          FROM vec_sessions v
          INNER JOIN vec_sessions_map m ON m.rowid = v.session_rowid
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE v.embedding MATCH ? AND k = ?
            AND s.project LIKE ?
          ORDER BY v.distance ASC
        `;
        params = [embeddingBuf, topK, project + "%"];
      } else {
        sql = `
          SELECT s.*, v.distance
          FROM vec_sessions v
          INNER JOIN vec_sessions_map m ON m.rowid = v.session_rowid
          INNER JOIN sessions s ON s.id = m.session_id
          WHERE v.embedding MATCH ? AND k = ?
          ORDER BY v.distance ASC
        `;
        params = [embeddingBuf, topK];
      }
      rows = this.db.prepare(sql).all(...params);
    }
    return rows.map((row) => {
      const distance = row.distance;
      return {
        id: row.id,
        project: row.project,
        started_at: row.started_at,
        ended_at: row.ended_at || void 0,
        summary: row.summary || void 0,
        status: row.status,
        similarity_score: distance != null ? l2DistanceToCosine(distance) : void 0
      };
    });
  }
  countUnembeddedSessions(project) {
    const sql = project ? `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND status = 'complete' AND project LIKE ?` : `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND status = 'complete'`;
    const row = project ? this.db.prepare(sql).get(project + "%") : this.db.prepare(sql).get();
    return row.count;
  }
  async getUnembeddedSessions(limit = 50, project) {
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT * FROM sessions
        WHERE embedding IS NULL AND status = 'complete' AND project LIKE ?
        ORDER BY started_at DESC
        LIMIT ?
      `;
      params = [project + "%", limit];
    } else {
      sql = `
        SELECT * FROM sessions
        WHERE embedding IS NULL AND status = 'complete'
        ORDER BY started_at DESC
        LIMIT ?
      `;
      params = [limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || void 0,
      summary: row.summary || void 0,
      status: row.status
    }));
  }
  async getUnembeddedObservations(limit = 100, project) {
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT * FROM observations
        WHERE embedding IS NULL AND project LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [project + "%", limit];
    } else {
      sql = `
        SELECT * FROM observations
        WHERE embedding IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  /**
   * Get recent sessions with their observations, grouped for display.
   */
  async getRecentSessionsWithObservations(project, sessionLimit = 10) {
    const sessions = await this.getRecentSessions(project, sessionLimit);
    const result = [];
    for (const session of sessions) {
      const observations = await this.getSessionObservations(session.id);
      result.push({ session, observations });
    }
    return result;
  }
  /**
   * Increment file encounter count and return the new count.
   * Uses upsert for atomic increment — sub-millisecond on primary key lookup.
   */
  incrementFileEncounter(filePath, project, toolName) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const row = this.db.prepare(`
      INSERT INTO file_encounter_counts (file_path, project, tool_name, encounter_count, last_seen)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(file_path, project, tool_name)
      DO UPDATE SET encounter_count = encounter_count + 1, last_seen = ?
      RETURNING encounter_count
    `).get(filePath, project, toolName, now, now);
    const recent = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM observations
      WHERE project = ? AND files_touched LIKE ? AND created_at > datetime('now', '-7 days')
    `).get(project, `%${filePath.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
    return recent.cnt;
  }
  /**
   * Infer and store relationships for a newly inserted observation.
   * Called from save() after INSERT — keeps relationship inference passive.
   */
  inferRelationships(observationId, observation) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const previous = this.db.prepare(`
      SELECT id FROM observations
      WHERE session_id = ? AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(observation.session_id, observationId);
    if (previous) {
      this.db.prepare(`
        INSERT OR IGNORE INTO observation_relationships (source_id, target_id, relationship, created_at)
        VALUES (?, ?, 'followed_by', ?)
      `).run(previous.id, observationId, now);
    }
    if (observation.files_touched.length > 0) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
      for (const file of observation.files_touched) {
        const likePattern = `%${file.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
        const matches = this.db.prepare(`
          SELECT id FROM observations
          WHERE project = ? AND id != ?
            AND files_touched LIKE ? ESCAPE '\\'
            AND created_at > ?
          ORDER BY created_at DESC
          LIMIT 5
        `).all(observation.project, observationId, likePattern, cutoff);
        for (const match of matches) {
          this.db.prepare(`
            INSERT OR IGNORE INTO observation_relationships (source_id, target_id, relationship, created_at)
            VALUES (?, ?, 'same_file', ?)
          `).run(match.id, observationId, now);
        }
      }
    }
  }
  /**
   * Get observations related to a given observation via inferred relationships.
   */
  getRelatedObservations(observationId, types, limit = 10) {
    let sql;
    let params;
    if (types && types.length > 0) {
      const placeholders = types.map(() => "?").join(", ");
      sql = `
        SELECT DISTINCT o.* FROM observations o
        INNER JOIN observation_relationships r
          ON (o.id = r.source_id AND r.target_id = ?)
          OR (o.id = r.target_id AND r.source_id = ?)
        WHERE r.relationship IN (${placeholders})
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [observationId, observationId, ...types, limit];
    } else {
      sql = `
        SELECT DISTINCT o.* FROM observations o
        INNER JOIN observation_relationships r
          ON (o.id = r.source_id AND r.target_id = ?)
          OR (o.id = r.target_id AND r.source_id = ?)
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [observationId, observationId, limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  close() {
    this.db.close();
  }
};

// src/utils/validation.ts
import { realpathSync } from "fs";
import { homedir as homedir2 } from "os";
import path2 from "path";
var ALLOWED_PROJECT_ROOTS = [
  path2.join(homedir2(), "Projects"),
  path2.join(homedir2(), "projects"),
  path2.join(homedir2(), "Dev"),
  path2.join(homedir2(), "dev"),
  path2.join(homedir2(), "Code"),
  path2.join(homedir2(), "code"),
  path2.join(homedir2(), "Workspace"),
  path2.join(homedir2(), "workspace"),
  path2.join(homedir2(), "Documents"),
  // Common location
  homedir2()
  // Allow home directory as fallback
];
function validateProjectPath(projectPath) {
  let normalizedPath;
  try {
    normalizedPath = realpathSync(projectPath);
  } catch (error) {
    normalizedPath = path2.resolve(projectPath);
  }
  const isAllowed = ALLOWED_PROJECT_ROOTS.some((root) => {
    try {
      const normalizedRoot = realpathSync(root);
      return normalizedPath.startsWith(normalizedRoot);
    } catch {
      return false;
    }
  });
  if (!isAllowed) {
    throw new Error(
      `Project path outside allowed roots: ${normalizedPath}. Allowed roots: ${ALLOWED_PROJECT_ROOTS.join(", ")}`
    );
  }
  return normalizedPath;
}
function validateStopInput(input) {
  if (typeof input !== "object" || input === null) {
    throw new Error("Invalid input: expected object");
  }
  const obj = input;
  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    throw new Error("Invalid input: session_id must be non-empty string");
  }
  if (typeof obj.cwd !== "string" || obj.cwd.length === 0) {
    throw new Error("Invalid input: cwd must be non-empty string");
  }
  const validatedCwd = validateProjectPath(obj.cwd);
  let transcriptPath;
  if (typeof obj.transcript_path === "string" && obj.transcript_path.length > 0) {
    const expectedRoot = path2.resolve(homedir2(), ".claude", "projects");
    try {
      const resolved = realpathSync(obj.transcript_path);
      if (resolved.startsWith(expectedRoot + path2.sep)) {
        transcriptPath = resolved;
      }
    } catch {
    }
  }
  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    transcript_path: transcriptPath
  };
}

// src/utils/logger.ts
import { appendFileSync, mkdirSync as mkdirSync2, statSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir as homedir3 } from "os";
var LOG_DIR = join(homedir3(), ".claude-context", "logs");
var MAX_LOG_SIZE = 1 * 1024 * 1024;
var KEEP_SIZE = 500 * 1024;
function isDebugEnabled() {
  return process.env.CONTEXT_MANAGER_DEBUG === "1";
}
function rotateIfNeeded(logFile) {
  try {
    const stats = statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const content = readFileSync(logFile, "utf8");
      const trimmed = content.slice(content.length - KEEP_SIZE);
      const firstNewline = trimmed.indexOf("\n");
      writeFileSync(logFile, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
    }
  } catch {
  }
}
function createDebugLogger(logFileName) {
  const logFile = join(LOG_DIR, logFileName);
  return (label, data) => {
    if (!isDebugEnabled())
      return;
    try {
      mkdirSync2(LOG_DIR, { recursive: true });
      rotateIfNeeded(logFile);
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const entry = data !== void 0 ? `[${timestamp}] ${label}: ${typeof data === "string" ? data : JSON.stringify(data, null, 2)}
` : `[${timestamp}] ${label}
`;
      appendFileSync(logFile, entry);
    } catch {
    }
  };
}

// src/export/memory.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, existsSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir4 } from "os";

// src/utils/transcript.ts
function convertPathToDashed(projectPath) {
  return projectPath.replace(/\//g, "-");
}

// src/utils/session-format.ts
function computeSessionDuration(session) {
  if (!session.ended_at)
    return "active";
  const start = new Date(session.started_at).getTime();
  const end = new Date(session.ended_at).getTime();
  if (isNaN(start) || isNaN(end) || end <= start)
    return "unknown";
  const minutes = Math.round((end - start) / 6e4);
  if (minutes < 1)
    return "<1m";
  if (minutes < 60)
    return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}
function extractSessionNarrative(summary, maxLen = 120) {
  if (!summary || summary.length < 10)
    return "";
  let text = summary.replace(/\*\*/g, "").replace(/`/g, "").trim();
  const sentenceEnd = text.search(/[.!?\n]/);
  if (sentenceEnd > 0 && sentenceEnd < maxLen) {
    text = text.substring(0, sentenceEnd + 1);
  } else if (text.length > maxLen) {
    text = text.substring(0, maxLen).replace(/\s+\S*$/, "") + "...";
  }
  if (text.match(/^(Let me|I'll|Here's the|Looking at|No response|Checking)/i)) {
    const afterFiller = summary.indexOf("\n");
    if (afterFiller > 0 && afterFiller < 200) {
      const next = summary.substring(afterFiller + 1).trim();
      if (next.length > 10) {
        return extractSessionNarrative(next, maxLen);
      }
    }
  }
  return text;
}

// src/export/memory.ts
var TOPIC_FILE = "context-manager-activity.md";
var DEFAULT_MAX_LINES = 150;
var MAX_ITEMS_PER_SESSION = 6;
function resolveMemoryDir(projectPath) {
  const dashedPath = convertPathToDashed(projectPath);
  return join2(homedir4(), ".claude", "projects", dashedPath, "memory");
}
function formatObservationsForMemory(observations, sessions) {
  if (observations.length === 0)
    return "";
  const sessionLookup = /* @__PURE__ */ new Map();
  if (sessions) {
    for (const s of sessions) {
      sessionLookup.set(s.id, s);
    }
  }
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
  for (const [date, sessionMap] of byDate) {
    lines.push(`## ${date}`);
    lines.push("");
    for (const [sessionId, sessionObs] of sessionMap) {
      const block = formatSessionBlock(sessionObs, sessionLookup.get(sessionId));
      if (block) {
        lines.push(block);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}
function formatSessionBlock(observations, session) {
  const sessionId = observations[0]?.session_id || "unknown";
  const shortId = sessionId.substring(0, 8);
  let heading;
  if (session) {
    const duration = computeSessionDuration(session);
    heading = `### Session ${shortId} (${duration}, ${observations.length} actions)`;
  } else {
    heading = `### ${shortId}`;
  }
  const narrative = session ? extractSessionNarrative(session.summary) : "";
  const created = [];
  const edited = /* @__PURE__ */ new Map();
  const commits = [];
  const commands = [];
  const insights = [];
  for (const obs of observations) {
    const file = obs.files_touched[0] || "";
    const shortFile = file ? file.split("/").slice(-2).join("/") : "";
    switch (obs.tool_name) {
      case "Write":
        created.push(shortFile);
        break;
      case "Edit": {
        const desc = describeEdit(obs);
        if (!edited.has(shortFile))
          edited.set(shortFile, []);
        edited.get(shortFile).push(desc);
        break;
      }
      case "Bash": {
        if (obs.summary.includes("git commit")) {
          const msg = obs.summary.match(/commit -m ["'](.+?)["']/)?.[1] || obs.summary.match(/"([^"]+)"/)?.[1] || "";
          if (msg)
            commits.push(msg.substring(0, 70));
        } else if (obs.summary.includes("git push")) {
          commands.push("Git push");
        } else if (obs.summary.includes("npm install") || obs.summary.includes("yarn add")) {
          commands.push("Install dependencies");
        } else if (obs.summary.includes("npm run test") || obs.summary.includes("npm test")) {
          commands.push("Tests");
        }
        break;
      }
      case "Conversation": {
        const insightText = obs.summary.substring(0, 80);
        if (insightText.length > 5) {
          insights.push(insightText);
        }
        break;
      }
      default:
        break;
    }
  }
  const items = [];
  if (created.length > 0) {
    if (created.length <= 3) {
      items.push(`Created ${created.join(", ")}`);
    } else {
      items.push(`Created ${created.slice(0, 3).join(", ")} + ${created.length - 3} more`);
    }
  }
  for (const [file, descriptions] of edited) {
    const meaningful = descriptions.filter((d) => d.length > 0);
    if (meaningful.length === 0)
      continue;
    const best = meaningful.find((d) => d.startsWith("Added") || d.startsWith("Schema")) || meaningful.find((d) => d.startsWith("Changed") || d.startsWith("Removed")) || meaningful[0] || "modified";
    items.push(`Edited ${file} \u2014 ${best}`);
  }
  if (commits.length > 0) {
    if (commits.length === 1) {
      items.push(`Commit: "${commits[0]}"`);
    } else {
      items.push(`${commits.length} commits: "${commits[0]}", "${commits[1]}"${commits.length > 2 ? ` + ${commits.length - 2} more` : ""}`);
    }
  }
  const uniqueCommands = [...new Set(commands)];
  if (uniqueCommands.length > 0) {
    items.push(uniqueCommands.join(", "));
  }
  for (const insight of insights.slice(0, 2)) {
    items.push(`Key insight: ${insight}`);
  }
  const cappedItems = items.slice(0, MAX_ITEMS_PER_SESSION);
  if (items.length > MAX_ITEMS_PER_SESSION) {
    cappedItems.push(`+ ${items.length - MAX_ITEMS_PER_SESSION} more changes`);
  }
  if (cappedItems.length === 0 && !narrative)
    return "";
  const itemLines = cappedItems.map((item) => `- ${item}`).join("\n");
  const parts = [heading];
  if (narrative)
    parts.push(narrative);
  if (itemLines)
    parts.push(itemLines);
  return parts.join("\n");
}
function describeEdit(obs) {
  const toolInput = obs.metadata?.tool_input;
  if (!toolInput)
    return "";
  const oldStr = toolInput.old_string || "";
  const newStr = toolInput.new_string || "";
  if (!oldStr && !newStr)
    return "";
  if (isVersionBump(oldStr, newStr))
    return "";
  const oldLines = oldStr.split("\n").map((l) => l.trim()).filter(Boolean);
  const newLines = newStr.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const addedLines = newLines.filter((l) => !oldSet.has(l));
  for (const line of addedLines) {
    const funcMatch = line.match(/(?:function|async function|class|const|export)\s+(\w+)/);
    if (funcMatch)
      return `Added ${funcMatch[0].substring(0, 60)}`;
    const importMatch = line.match(/import\s+.+from\s+['"](.+?)['"]/);
    if (importMatch)
      return `Added import from '${importMatch[1]}'`;
    const typeMatch = line.match(/(?:interface|type)\s+(\w+)/);
    if (typeMatch)
      return `Added ${typeMatch[0]}`;
    const toolMatch = line.match(/['"](\w+)['"]/);
    if (line.includes("server.tool") && toolMatch)
      return `Added tool '${toolMatch[1]}'`;
    if (line.includes('"dependencies"') || line.match(/["']\w+["']\s*:\s*["']\^/)) {
      const depMatch = line.match(/["'](@?[\w/-]+)["']\s*:/);
      if (depMatch)
        return `Added dependency ${depMatch[1]}`;
    }
    if (line.includes("CREATE TABLE") || line.includes("CREATE VIRTUAL TABLE") || line.includes("ALTER TABLE")) {
      return `Schema change: ${line.substring(0, 60)}`;
    }
  }
  const netLines = newLines.length - oldLines.length;
  if (netLines > 5)
    return `Added ~${netLines} lines`;
  if (netLines < -5)
    return `Removed ~${Math.abs(netLines)} lines`;
  if (addedLines.length > 0) {
    const hint = addedLines[0].substring(0, 60);
    if (hint.length >= 10 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Changed: ${hint}`;
    }
  }
  return "";
}
function isVersionBump(oldStr, newStr) {
  const versionPattern = /["']?version["']?\s*[:=]\s*["']?\d+\.\d+\.\d+/;
  const oldHasVersion = versionPattern.test(oldStr);
  const newHasVersion = versionPattern.test(newStr);
  if (oldHasVersion && newHasVersion) {
    const normalize = (s) => s.replace(/\d+\.\d+\.\d+/g, "X.X.X").trim();
    if (normalize(oldStr) === normalize(newStr))
      return true;
  }
  return false;
}
function mergeSessionBlocks(existingBody, newContent) {
  if (!existingBody && !newContent)
    return "";
  if (!existingBody)
    return newContent.trimEnd();
  if (!newContent)
    return existingBody.trimEnd();
  const existingBlocks = parseSessionBlocks(existingBody);
  const newBlocks = parseSessionBlocks(newContent);
  for (const newBlock of newBlocks) {
    const existing = existingBlocks.find((b) => b.sessionId === newBlock.sessionId);
    if (existing) {
      const existingItems = new Set(existing.items.map((l) => l.trim()));
      for (const item of newBlock.items) {
        if (!existingItems.has(item.trim())) {
          existing.items.push(item);
        }
      }
      if (existing.items.length > MAX_ITEMS_PER_SESSION) {
        const overflow = existing.items.length - MAX_ITEMS_PER_SESSION;
        existing.items = existing.items.slice(0, MAX_ITEMS_PER_SESSION);
        existing.items.push(`+ ${overflow} more changes`);
      }
    } else {
      existingBlocks.push(newBlock);
    }
  }
  return rebuildFromBlocks(existingBlocks);
}
function parseSessionBlocks(body) {
  const blocks = [];
  let currentDate = "";
  let currentBlock = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      currentDate = line.substring(3).trim();
    } else if (line.startsWith("### ")) {
      if (currentBlock)
        blocks.push(currentBlock);
      const headingText = line.substring(4).trim();
      const sessionId = headingText.replace(/^Session\s+/, "").split(/[\s—(]/)[0] || headingText;
      currentBlock = {
        date: currentDate,
        sessionId,
        heading: line,
        items: []
      };
    } else if (line.startsWith("- ") && currentBlock) {
      currentBlock.items.push(line);
    }
  }
  if (currentBlock)
    blocks.push(currentBlock);
  return blocks;
}
function rebuildFromBlocks(blocks) {
  const byDate = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (!byDate.has(block.date))
      byDate.set(block.date, []);
    byDate.get(block.date).push(block);
  }
  const lines = [];
  for (const [date, dateBlocks] of byDate) {
    lines.push(`## ${date}`);
    lines.push("");
    for (const block of dateBlocks) {
      lines.push(block.heading);
      lines.push(...block.items);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}
function writeActivityToMemory(projectPath, newContent, maxLines = DEFAULT_MAX_LINES) {
  const memoryDir = resolveMemoryDir(projectPath);
  mkdirSync3(memoryDir, { recursive: true });
  const filePath = join2(memoryDir, TOPIC_FILE);
  const header = [
    "# Project Activity Log",
    "",
    `> Auto-generated by context-manager. Updated ${(/* @__PURE__ */ new Date()).toISOString()}.`,
    "> Use context_search MCP tool for full history search.",
    ""
  ].join("\n");
  let existingBody = "";
  if (existsSync(filePath)) {
    const existing = readFileSync2(filePath, "utf-8");
    const bodyMatch = existing.match(/^(## .+)/m);
    if (bodyMatch?.index !== void 0) {
      existingBody = existing.substring(bodyMatch.index);
    }
  }
  const fullBody = mergeSessionBlocks(existingBody, newContent);
  const bodyLines = fullBody.split("\n");
  const trimmedBody = bodyLines.length > maxLines ? bodyLines.slice(bodyLines.length - maxLines).join("\n") : fullBody;
  const finalContent = header + trimmedBody + "\n";
  writeFileSync2(filePath, finalContent);
  return { filePath, linesWritten: trimmedBody.split("\n").length };
}
async function exportToAutoMemory(storage, projectPath, sessionId) {
  const observations = await storage.getUnexportedHighImportance(
    projectPath,
    sessionId
  );
  if (observations.length === 0) {
    return { exported: 0, filePath: null };
  }
  const sessionIds = [...new Set(observations.map((o) => o.session_id))];
  const sessions = await storage.getRecentSessions(projectPath, 50);
  const relevantSessions = sessions.filter((s) => sessionIds.includes(s.id));
  const formatted = formatObservationsForMemory(observations, relevantSessions);
  const { filePath } = writeActivityToMemory(projectPath, formatted);
  const ids = observations.map((o) => o.id).filter((id) => id !== void 0);
  if (ids.length > 0) {
    await storage.markExported(ids);
  }
  return { exported: observations.length, filePath };
}

// src/utils/sanitize.ts
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// plugin/hooks/session-end.ts
import * as fs from "fs";
var debugLog = createDebugLogger("stop-hook-debug.log");
function scoreForNarrative(text) {
  if (text.length < 50)
    return 0;
  const lower = text.toLowerCase().trimStart();
  if (text.length < 200) {
    if (/^(yes|sure|ok|okay|alright|got it|sounds good|perfect|great|done|correct|right|no problem|will do|absolutely)\b/.test(lower))
      return 0;
    if (/^(let me |i'll |i've |checking|looking|reading|searching)/.test(lower))
      return 0;
  }
  let score = 0;
  if (text.length >= 150)
    score += 0.15;
  if (text.length >= 400)
    score += 0.1;
  if (text.length > 3e3)
    score -= 0.1;
  if (/\b(implement|add|fix|update|creat|refactor|chang|remov|improv|build|replac|rewrit)\w*\b/i.test(text))
    score += 0.2;
  if (/\b\w+\.(ts|js|py|yaml|yml|json|md|sql)\b/.test(text))
    score += 0.15;
  if (text.includes("```"))
    score += 0.1;
  const bulletCount = (text.match(/^[-*]\s/gm) || []).length;
  if (bulletCount >= 2)
    score += 0.1;
  if (text.trimEnd().endsWith("?"))
    score -= 0.1;
  return Math.max(0, Math.min(1, score));
}
function extractTextFromMessage(msg) {
  const msgContent = msg.message?.content;
  if (!msgContent)
    return "";
  if (typeof msgContent === "string")
    return msgContent;
  if (Array.isArray(msgContent)) {
    return msgContent.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n");
  }
  return "";
}
function extractSummaryFromTranscript(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) {
      debugLog("TRANSCRIPT_NOT_FOUND", transcriptPath);
      return { summary: void 0, summaryExtended: void 0 };
    }
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.trim().split("\n").filter((line) => line.trim());
    if (lines.length === 0) {
      debugLog("TRANSCRIPT_EMPTY", transcriptPath);
      return { summary: void 0, summaryExtended: void 0 };
    }
    try {
      const firstLine = JSON.parse(lines[0]);
      if (firstLine.summary && typeof firstLine.summary === "string") {
        debugLog("FOUND_SUMMARY_IN_FIRST_LINE", firstLine.summary.substring(0, 200));
        return { summary: firstLine.summary, summaryExtended: void 0 };
      }
    } catch {
    }
    const scored = [];
    let lastAssistantContent = "";
    for (const rawLine of lines) {
      try {
        const msg = JSON.parse(rawLine);
        if (msg.type !== "assistant" || msg.message?.role !== "assistant")
          continue;
        const text = extractTextFromMessage(msg);
        if (!text)
          continue;
        lastAssistantContent = text;
        const score = scoreForNarrative(text);
        scored.push({ text, score });
      } catch {
        continue;
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const qualifying = scored.filter((m) => m.score >= 0.25);
    const bestText = qualifying.length > 0 ? qualifying[0].text : lastAssistantContent;
    const bestScore = qualifying.length > 0 ? qualifying[0].score : -1;
    if (!bestText) {
      debugLog("NO_ASSISTANT_MESSAGE_FOUND", { lineCount: lines.length });
      return { summary: void 0, summaryExtended: void 0 };
    }
    const summary = bestText.length > 1500 ? bestText.substring(0, 1500) + "..." : bestText;
    debugLog("EXTRACTED_SUMMARY", { score: bestScore, length: summary.length, preview: summary.substring(0, 200) });
    let summaryExtended;
    if (qualifying.length >= 2) {
      const beats = qualifying.slice(0, 3).map(
        (m) => m.text.length > 800 ? m.text.substring(0, 800) + "..." : m.text
      );
      summaryExtended = beats.join("\n\n---\n\n");
      debugLog("EXTRACTED_SUMMARY_EXTENDED", { beats: beats.length, length: summaryExtended.length });
    }
    return { summary, summaryExtended };
  } catch (error) {
    debugLog("TRANSCRIPT_READ_ERROR", { error: String(error), path: transcriptPath });
    return { summary: void 0, summaryExtended: void 0 };
  }
}
var HIGH_SIGNAL_PATTERNS = {
  /** Markdown tables — structured comparisons, recommendations, specs */
  hasTable: (text) => {
    const lines = text.split("\n");
    let tableRows = 0;
    for (const line of lines) {
      if (line.includes("|") && line.trim().startsWith("|")) {
        tableRows++;
        if (tableRows >= 3)
          return true;
      }
    }
    return false;
  },
  /** Decision/recommendation language */
  hasRecommendation: (text) => {
    const lower = text.toLowerCase();
    const patterns = [
      "recommend",
      "my take",
      "i'd go with",
      "best option",
      "here's what you need",
      "you should",
      "the winner",
      "updated recommendation",
      "revised",
      "landing on",
      "option 1",
      "option 2",
      "comparison"
    ];
    return patterns.some((p) => lower.includes(p));
  },
  /** Price/cost analysis */
  hasPriceAnalysis: (text) => {
    const pricePattern = /\$\d+[\d,.]*.*\$\d+[\d,.]*|\btotal\b.*\$\d+/i;
    return pricePattern.test(text);
  },
  /** User fact statements (short, declarative) */
  hasUserFact: (text) => {
    const lower = text.toLowerCase();
    return lower.includes("you don't have") || lower.includes("you don't own") || lower.includes("you confirmed") || lower.includes("you mentioned") || lower.includes("you said");
  }
};
function scoreAssistantBlock(text) {
  if (text.length < 100 || text.length > 15e3)
    return 0;
  const lower = text.toLowerCase();
  if (lower.startsWith("let me ") && text.length < 200)
    return 0;
  if (lower.startsWith("i'll ") && text.length < 200)
    return 0;
  if (lower.includes("let me check") && text.length < 200)
    return 0;
  if (lower.includes("let me search") && text.length < 200)
    return 0;
  let score = 0;
  if (HIGH_SIGNAL_PATTERNS.hasTable(text))
    score += 0.4;
  if (HIGH_SIGNAL_PATTERNS.hasRecommendation(text))
    score += 0.3;
  if (HIGH_SIGNAL_PATTERNS.hasPriceAnalysis(text))
    score += 0.2;
  if (HIGH_SIGNAL_PATTERNS.hasUserFact(text))
    score += 0.2;
  const headerCount = (text.match(/^#{1,3}\s/gm) || []).length;
  const bulletCount = (text.match(/^[-*]\s/gm) || []).length;
  if (headerCount >= 2)
    score += 0.1;
  if (bulletCount >= 3)
    score += 0.1;
  return Math.min(1, score);
}
function compressAssistantBlock(text) {
  const lines = text.split("\n");
  const kept = [];
  let totalLen = 0;
  const MAX_SUMMARY = 600;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed)
      continue;
    const isTable = trimmed.startsWith("|") && trimmed.includes("|");
    const isHeader = /^#{1,3}\s/.test(trimmed);
    const isBullet = /^[-*]\s/.test(trimmed);
    const hasMoney = /\$\d+/.test(trimmed);
    const isDecision = /\b(recommend|total|option|best|winner|you don't)\b/i.test(trimmed);
    if (isTable && /^\|[\s-:|]+\|$/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    if (isTable || isHeader || isBullet && (hasMoney || trimmed.length > 20) || isDecision || hasMoney) {
      if (totalLen + trimmed.length > MAX_SUMMARY)
        break;
      kept.push(trimmed);
      totalLen += trimmed.length;
    }
  }
  return kept.join("\n");
}
function extractConversationInsights(transcriptPath, sessionId, project) {
  const insights = [];
  try {
    if (!fs.existsSync(transcriptPath))
      return insights;
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.trim().split("\n").filter((line) => line.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== "assistant" || msg.message?.role !== "assistant")
          continue;
        let text = "";
        const msgContent = msg.message.content;
        if (typeof msgContent === "string") {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n");
        }
        if (!text)
          continue;
        const score = scoreAssistantBlock(text);
        if (score < 0.3)
          continue;
        const compressed = compressAssistantBlock(text);
        if (compressed.length < 30)
          continue;
        let summary = "Conversation insight";
        const firstHeader = text.match(/^#{1,3}\s+(.+)$/m);
        if (firstHeader?.[1]) {
          summary = firstHeader[1].substring(0, 100);
        } else {
          const firstLine = text.split("\n").find((l) => l.trim().length > 20);
          if (firstLine) {
            summary = firstLine.trim().substring(0, 100);
          }
        }
        const tokenEstimate = estimateTokens(`${summary}
${compressed}`);
        let importance;
        if (score >= 0.5)
          importance = "high";
        else if (score >= 0.3)
          importance = "medium";
        else
          importance = "low";
        insights.push({
          session_id: sessionId,
          project,
          tool_name: "Conversation",
          summary,
          files_touched: [],
          metadata: {
            stored_output: compressed,
            output_stats: {
              original_length: text.length,
              line_count: text.split("\n").length,
              truncated: compressed.length < text.length
            }
          },
          token_estimate: tokenEstimate,
          importance,
          importance_score: Math.round(score * 100) / 100,
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      } catch {
        continue;
      }
    }
    insights.sort((a, b) => b.importance_score - a.importance_score);
    return insights.slice(0, 10);
  } catch (error) {
    debugLog("CONVERSATION_EXTRACT_ERROR", { error: String(error) });
    return [];
  }
}
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
function writeResponse(data) {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(JSON.stringify(data) + "\n");
    if (ok) {
      resolve();
    } else {
      process.stdout.once("drain", resolve);
      process.stdout.once("error", reject);
    }
  });
}
async function main() {
  const storage = new SQLiteStorage();
  try {
    const inputStr = await readStdin();
    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      debugLog("JSON_PARSE_ERROR", { error: String(parseError) });
      console.error("[context-manager] Invalid JSON input");
      await writeResponse({ status: "error" });
      return;
    }
    debugLog("PARSED_KEYS", Object.keys(rawInput).join(", "));
    debugLog("HAS_TRANSCRIPT_PATH", {
      has: "transcript_path" in rawInput,
      hasValue: typeof rawInput.transcript_path === "string" && rawInput.transcript_path.length > 0
    });
    const input = validateStopInput(rawInput);
    let summary;
    let summaryExtended;
    if (input.transcript_path) {
      ({ summary, summaryExtended } = extractSummaryFromTranscript(input.transcript_path));
    }
    debugLog("SUMMARY_RESULT", {
      hasTranscriptPath: !!input.transcript_path,
      hasSummary: !!summary,
      summaryLength: summary?.length
    });
    await storage.initialize();
    if (input.transcript_path) {
      try {
        const insights = extractConversationInsights(
          input.transcript_path,
          input.session_id,
          input.cwd
        );
        const existingObs = await storage.getSessionObservations(input.session_id);
        const existingSummaries = new Set(
          existingObs.filter((o) => o.tool_name === "Conversation").map((o) => o.summary)
        );
        for (const insight of insights) {
          if (!existingSummaries.has(insight.summary)) {
            await storage.save(insight);
          }
        }
        if (insights.length > 0) {
          debugLog("CONVERSATION_INSIGHTS", { count: insights.length });
          console.error(`[context-manager] Extracted ${insights.length} conversation insights`);
        }
      } catch (insightError) {
        debugLog("CONVERSATION_INSIGHT_ERROR", { error: String(insightError) });
        console.error("[context-manager] Conversation insight extraction failed:", insightError);
      }
    }
    await storage.endSession(input.session_id, summary, summaryExtended);
    try {
      const result = await exportToAutoMemory(storage, input.cwd, input.session_id);
      if (result.exported > 0) {
        console.error(`[context-manager] Exported ${result.exported} observations to auto-memory`);
      }
    } catch (exportError) {
      console.error("[context-manager] Auto-memory export failed:", exportError);
    }
    await writeResponse({ status: "complete" });
  } catch (error) {
    debugLog("SESSION_END_ERROR", { error: String(error) });
    console.error("[context-manager] Session end error:", error);
    await writeResponse({ status: "error" });
  } finally {
    storage.close();
  }
}
main();
