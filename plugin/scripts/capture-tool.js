#!/usr/bin/env node
import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
const __betterSqlite3 = __ctxRequire('better-sqlite3');
const __sqliteVec = __ctxRequire('sqlite-vec');

// shim:better-sqlite3
var better_sqlite3_default = __betterSqlite3;

// src/storage/sqlite.ts
import { homedir } from "os";
import { randomUUID } from "crypto";
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
  /** Exposed only for admin/migration tooling. Do not use in normal storage paths. */
  get rawDb() {
    return this.db;
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
    this.migrateAddLastCheckpointAt();
    this.migrateAddSessionSource();
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
    const parsed = parseInt(process.env.CONTEXT_MANAGER_TOKEN_BUDGET || "4000", 10);
    const TOKEN_BUDGET = Number.isFinite(parsed) && parsed > 0 && parsed <= 1e5 ? parsed : 4e3;
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
  async updateSessionDraftSummary(sessionId, summary) {
    if (!summary)
      return;
    this.db.prepare(`
      UPDATE sessions SET summary = ? WHERE id = ?
    `).run(summary, sessionId);
  }
  async updateSessionCheckpoint(sessionId, timestamp) {
    this.db.prepare(`
      UPDATE sessions SET last_checkpoint_at = ? WHERE id = ?
    `).run(timestamp, sessionId);
  }
  async getSessionTimestamps(sessionId) {
    const row = this.db.prepare(`
      SELECT started_at, last_checkpoint_at FROM sessions WHERE id = ?
    `).get(sessionId);
    return row ?? null;
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
  async getRecentSessionsWithCounts(project, limit, offset, status) {
    const statusClause = status ? "AND s.status = ?" : "";
    const sql = `
      SELECT
        s.id, s.project, s.started_at, s.ended_at,
        s.summary, s.summary_extended, s.status,
        COUNT(o.id) AS observation_count,
        COALESCE(SUM(o.token_estimate), 0) AS total_tokens
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      WHERE s.project LIKE ? || '%'
        ${statusClause}
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ? OFFSET ?
    `;
    const params = status ? [project, status, limit, offset] : [project, limit, offset];
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || void 0,
      summary: row.summary || void 0,
      summary_extended: row.summary_extended || void 0,
      status: row.status,
      observation_count: row.observation_count,
      total_tokens: row.total_tokens
    }));
  }
  async closeStaleActiveSessions(staleSessionHours = 2) {
    const staleThresholdMs = Date.now() - staleSessionHours * 60 * 60 * 1e3;
    const staleThresholdISO = new Date(staleThresholdMs).toISOString();
    const staleResult = this.db.prepare(`
      UPDATE sessions
      SET
        status = 'complete',
        ended_at = datetime('now'),
        summary = '[Session ended abnormally - no Stop hook fired]'
      WHERE status = 'active'
        AND ended_at IS NULL
        AND (
          (last_checkpoint_at IS NOT NULL
            AND datetime(last_checkpoint_at / 1000, 'unixepoch') < ?)
          OR
          (last_checkpoint_at IS NULL
            AND started_at < ?)
        )
    `).run(staleThresholdISO, staleThresholdISO);
    return staleResult.changes;
  }
  async vacuum(olderThanDays, staleSessionHours = 2) {
    let deletedObservations = 0;
    const closedStaleSessions = await this.closeStaleActiveSessions(staleSessionHours);
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
      compacted_originals: compactionResult.originals,
      closedStaleSessions
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
    return Promise.resolve(this.vecEnabled);
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
  /**
   * Migration: add last_checkpoint_at column for periodic checkpoint tracking.
   * Stores the Unix epoch millisecond timestamp of the last checkpoint run.
   * NULL means no checkpoint has run for this session (use started_at as baseline).
   */
  migrateAddLastCheckpointAt() {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("last_checkpoint_at")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_checkpoint_at INTEGER`);
    }
  }
  /**
   * Migration: add source column to sessions table.
   * Distinguishes hook-driven sessions ('hook') from manually-created sessions ('manual').
   * Existing rows default to 'hook' — no backfill needed.
   */
  migrateAddSessionSource() {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("source")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'hook'`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_source_project
      ON sessions(source, project, started_at DESC)
    `);
  }
  async getOrCreateManualSession(project) {
    const existing = this.db.prepare(`
      SELECT id FROM sessions
      WHERE project = ?
        AND source = 'manual'
        AND date(started_at) = date('now', 'localtime')
        AND status = 'active'
      LIMIT 1
    `).get(project);
    if (existing) {
      return existing.id;
    }
    const sessionId = randomUUID();
    this.db.prepare(`
      INSERT INTO sessions (id, project, started_at, status, source)
      VALUES (?, ?, ?, 'active', 'manual')
    `).run(sessionId, project, (/* @__PURE__ */ new Date()).toISOString());
    return sessionId;
  }
  async addManualObservation(params) {
    const { text, project, sessionId, importanceScore, tags } = params;
    let importance;
    if (importanceScore >= 0.65) {
      importance = "high";
    } else if (importanceScore >= 0.35) {
      importance = "medium";
    } else {
      importance = "low";
    }
    const tokenEstimate = Math.ceil(text.length / 4);
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const contentHash = sha256(`${text}
[]
`);
    const hashCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM observations
      WHERE project LIKE ? AND content_hash = ?
    `).get(project + "%", contentHash);
    if (hashCheck.count > 0) {
      return void 0;
    }
    const info = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, tool_name, summary,
        files_touched, metadata, token_estimate,
        importance, importance_score, tags, content_hash, created_at
      ) VALUES (?, ?, 'Manual', ?, '[]', '{}', ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      project,
      text,
      tokenEstimate,
      importance,
      importanceScore,
      tags ?? null,
      contentHash,
      createdAt
    );
    return Number(info.lastInsertRowid);
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
    return Promise.resolve(row.count);
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
      WHERE project = ? AND files_touched LIKE ? ESCAPE '\\' AND created_at > datetime('now', '-7 days')
    `).get(project, `%${filePath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);
    return Promise.resolve(recent.cnt);
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
      for (const file of observation.files_touched) {
        const likePattern = `%${file.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
        const crossMatches = this.db.prepare(`
          SELECT id FROM observations
          WHERE project != ? AND id != ?
            AND files_touched LIKE ? ESCAPE '\\'
            AND created_at > ?
          ORDER BY created_at DESC
          LIMIT 5
        `).all(observation.project, observationId, likePattern, cutoff);
        for (const match of crossMatches) {
          this.db.prepare(`
            INSERT OR IGNORE INTO observation_relationships (source_id, target_id, relationship, created_at)
            VALUES (?, ?, 'cross_project_same_file', ?)
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
    return Promise.resolve(rows.map((row) => this.mapRow(row)));
  }
  /**
   * Get prior observations about a specific file from previous sessions.
   *
   * Searches files_touched (JSON array stored as text) for the file path,
   * filtered to file-operation tools (Read, Edit, Write) from sessions other
   * than the current one. Results ordered by recency.
   */
  getFileHistory(filePath, projectPrefix, excludeSessionId, limit) {
    const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const likePattern = `%${escapedPath}%`;
    const sql = `
      SELECT * FROM observations
      WHERE project LIKE ?
        AND session_id != ?
        AND files_touched LIKE ? ESCAPE '\\'
        AND tool_name IN ('Read', 'Edit', 'Write')
      ORDER BY created_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(
      projectPrefix + "%",
      excludeSessionId,
      likePattern,
      limit
    );
    return Promise.resolve(rows.map((row) => this.mapRow(row)));
  }
  /**
   * Check whether the current session already has an observation touching the
   * given file. Uses a single indexed SQL query instead of fetching all session
   * observations into application memory.
   *
   * @param sessionId - Session ID to check
   * @param likePattern - LIKE-escaped pattern for the file path (e.g. "%file.ts%")
   */
  async hasSessionSeenFile(sessionId, likePattern) {
    const row = this.db.prepare(`
      SELECT 1 FROM observations
      WHERE session_id = ?
        AND files_touched LIKE ? ESCAPE '\\'
      LIMIT 1
    `).get(sessionId, likePattern);
    return row !== void 0;
  }
  async getTopConversationObservation(sessionId) {
    const row = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ?
        AND tool_name = 'Conversation'
      ORDER BY importance_score DESC
      LIMIT 1
    `).get(sessionId);
    if (!row)
      return null;
    return this.mapRow(row);
  }
  close() {
    this.db.close();
    return Promise.resolve();
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
function validatePostToolUseInput(input) {
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
  if (typeof obj.tool_name !== "string" || obj.tool_name.length === 0) {
    throw new Error("Invalid input: tool_name must be non-empty string");
  }
  const validatedCwd = validateProjectPath(obj.cwd);
  let toolResponse;
  if (typeof obj.tool_response === "string") {
    toolResponse = obj.tool_response;
  } else if (typeof obj.tool_response === "object" && obj.tool_response !== null) {
    const resp = obj.tool_response;
    const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
    const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
    toolResponse = stderr ? `${stdout}
[stderr]
${stderr}` : stdout;
  }
  return {
    session_id: obj.session_id,
    cwd: validatedCwd,
    tool_name: obj.tool_name,
    tool_input: obj.tool_input,
    tool_response: toolResponse
  };
}
function shouldCaptureTool(toolName, toolInput) {
  const SKIP_TOOLS = [
    "TodoWrite",
    "AskUserQuestion",
    "SlashCommand",
    // Meta/orchestration tools - zero cross-session value
    "Task",
    "TaskCreate",
    "TaskUpdate",
    "TaskGet",
    "TaskOutput",
    "TaskList",
    "TaskStop",
    "AgentOutputTool",
    "BashOutput",
    "KillShell",
    "Skill",
    "EnterPlanMode",
    "ExitPlanMode",
    "EnterWorktree"
  ];
  if (SKIP_TOOLS.includes(toolName)) {
    return false;
  }
  if (toolName === "Bash" && toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const command = typeof input.command === "string" ? input.command : "";
    const SKIP_BASH_PATTERNS = [
      /^cd\s+[^&|;]+$/,
      // Simple cd (no chaining)
      /^cd\s+.+&&/,
      // Any cd && chain (usually just navigation)
      /^pwd$/,
      // Current directory
      /^ls\s+-la?\s*$/,
      // Basic ls without path
      /^ls\s+-la?\s+[^\|]+$/,
      // Basic ls with path (no piping)
      /^echo\s+['"]?DISPATCHER/i,
      // Dispatcher protocol messages
      /^echo\s+['"]?<user-prompt/i,
      // User prompt hook messages
      /^echo\s+['"]?(Success|===|═)/i,
      // Status echo messages and banners
      /^echo\s+['"]?\n?═/,
      // Banner lines starting with box chars
      /^cat\s*<<\s*['"]?EOF/i,
      // Here-docs (usually banner output)
      /^clear$/,
      // Clear screen
      /^history/,
      // History commands
      /^which\s+/,
      // Which commands
      /^type\s+/,
      // Type commands
      /^find\s+/,
      // Find commands (verbose output)
      // Exploratory/read-only commands with low cross-session value
      /^cat\s+/,
      // cat file reads
      /^head\s+/,
      // head file reads
      /^tail\s+/,
      // tail file reads
      /^wc\s+/,
      // Word/line count
      /^file\s+/,
      // File type detection
      /^stat\s+/,
      // File stats
      /^diff\s+/,
      // File diffs (exploratory)
      /^git\s+stash\s+list/,
      // Git stash listing
      /^git\s+branch\s*($|\s+-[^dD])/,
      // Git branch listing (not delete)
      /^docker\s+(ps|images)\b/,
      // Docker listing commands
      /^kubectl\s+get\b/
      // Kubernetes listing commands
    ];
    for (const pattern of SKIP_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return false;
      }
    }
  }
  if (toolName === "Read" && toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    const SKIP_READ_PATTERNS = [
      /\/node_modules\//,
      // Vendored dependencies
      /\/\.git\//,
      // Git internals
      /\/(dist|build|out|\.next)\//,
      // Build output directories
      /\/package-lock\.json$/,
      // npm lock file
      /\/yarn\.lock$/,
      // Yarn lock file
      /\/pnpm-lock\.yaml$/
      // pnpm lock file
    ];
    for (const pattern of SKIP_READ_PATTERNS) {
      if (pattern.test(filePath)) {
        return false;
      }
    }
  }
  if (toolName === "Glob" && toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const SKIP_GLOB_PATTERNS = [
      /^\*$/,
      // Just "*" - matches everything
      /^\*\.\*$/
      // "*.*" - matches all files with extensions
    ];
    for (const p of SKIP_GLOB_PATTERNS) {
      if (p.test(pattern)) {
        return false;
      }
    }
  }
  if (toolName === "Edit" && toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    const SKIP_EDIT_PATTERNS = [
      /\/summary\.md$/,
      // Agent summary files
      /\/worklog\.md$/,
      // Agent worklog files
      /\/\.agent-.*\.md$/
      // Agent temp files
    ];
    for (const pattern of SKIP_EDIT_PATTERNS) {
      if (pattern.test(filePath)) {
        return false;
      }
    }
  }
  return true;
}

// src/utils/sanitize.ts
function stripPrivateTags(content) {
  let result = "";
  let i = 0;
  const openTag = "<private>";
  const closeTag = "</private>";
  while (i < content.length) {
    const remainingLength = content.length - i;
    if (remainingLength >= openTag.length && content.substring(i, i + openTag.length) === openTag) {
      const closeIndex = content.indexOf(closeTag, i + openTag.length);
      if (closeIndex !== -1) {
        result += "[REDACTED]";
        i = closeIndex + closeTag.length;
      } else {
        result += "[REDACTED]";
        i = content.length;
      }
      continue;
    }
    result += content[i];
    i++;
  }
  return result;
}
var SENSITIVE_PATTERNS = [
  // API keys
  { pattern: /\b(sk|pk|api|token)[-_]?[a-zA-Z0-9]{20,}\b/gi, replacement: "[API_KEY_REDACTED]" },
  // AWS credentials
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[AWS_KEY_REDACTED]" },
  {
    pattern: /aws_secret_access_key\s*=\s*[^\s]+/gi,
    replacement: "aws_secret_access_key=[REDACTED]"
  },
  // JWT tokens (basic pattern - 3 base64 segments separated by dots)
  {
    pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
    replacement: "[JWT_REDACTED]"
  },
  // URLs with embedded credentials
  {
    pattern: /(\w+):\/\/[^:]+:[^@]+@[^\s]+/gi,
    replacement: (match) => {
      try {
        const url = new URL(match);
        return `${url.protocol}//${url.hostname}${url.pathname}`;
      } catch {
        return "[URL_WITH_CREDENTIALS_REDACTED]";
      }
    }
  },
  // Environment variables with common secret names
  {
    pattern: /(PASSWORD|SECRET|TOKEN|KEY|CREDENTIALS?)\s*[:=]\s*['"]?([^\s'"]+)['"]?/gi,
    replacement: "$1=[REDACTED]"
  },
  // Private keys
  {
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: "[PRIVATE_KEY_REDACTED]"
  }
];
function sanitizeSensitiveData(content) {
  let sanitized = content;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    if (typeof replacement === "function") {
      sanitized = sanitized.replace(pattern, replacement);
    } else {
      sanitized = sanitized.replace(pattern, replacement);
    }
  }
  return sanitized;
}
function sanitizeContent(content) {
  let sanitized = stripPrivateTags(content);
  sanitized = sanitizeSensitiveData(sanitized);
  return sanitized;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// src/utils/version.ts
function isVersionBump(filePath) {
  return /package\.json|pyproject\.toml|version\.ts/.test(filePath);
}

// src/capture/processor.ts
var OUTPUT_THRESHOLDS = {
  FULL_STORAGE_LIMIT: 800,
  // chars - store full if under this (was 1500)
  HEAD_SIZE: 400,
  // chars - first N for long outputs (was 800)
  TAIL_SIZE: 200,
  // chars - last N for long outputs (was 400)
  MAX_STORAGE: 700
  // chars - absolute max stored (was 1600)
};
var REDUCED_OUTPUT_THRESHOLDS = {
  FULL_STORAGE_LIMIT: 300,
  // chars - aggressive truncation
  HEAD_SIZE: 150,
  // chars - keep query/command visible
  TAIL_SIZE: 100
  // chars - minimal tail
};
function shouldUseReducedLimits(toolName, toolInput) {
  if (toolName !== "Bash")
    return false;
  const input = toolInput;
  const command = typeof input?.command === "string" ? input.command : "";
  if (command.includes("psql")) {
    return true;
  }
  if (command.includes("sqlite3")) {
    return true;
  }
  if (command.startsWith("ssh ") && (command.includes(" cat ") || command.includes(" logs "))) {
    return true;
  }
  if (command.includes("pytest") || command.includes("python -m pytest")) {
    return true;
  }
  if (command.includes("npm run") && (command.includes("test") || command.includes("build"))) {
    return true;
  }
  if (/^(ls|du|df|wc|find)\s/.test(command) || command === "ls" || command === "du" || command === "df") {
    return true;
  }
  if (/^python3?\s+-c\s+/.test(command)) {
    return true;
  }
  return false;
}
function extractFilesTouched(toolName, toolInput, toolResponse) {
  const files = [];
  if (toolInput && typeof toolInput === "object") {
    const input = toolInput;
    const pathFields = ["file_path", "path", "filepath", "file"];
    for (const field of pathFields) {
      if (typeof input[field] === "string") {
        files.push(input[field]);
      }
    }
  }
  return [...new Set(files)];
}
function extractBashStats(output) {
  const stats = {};
  const exitCodeMatch = output.match(/exit\s+code:\s*(\d+)/i);
  if (exitCodeMatch && exitCodeMatch[1]) {
    stats.exit_code = parseInt(exitCodeMatch[1], 10);
  }
  return Object.keys(stats).length > 0 ? stats : void 0;
}
function extractGrepStats(output, toolInput) {
  const stats = {};
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  stats.match_count = lines.length;
  return stats;
}
function extractGlobStats(output) {
  const stats = {};
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  stats.file_count = lines.length;
  return stats;
}
function extractOutput(output, toolName, toolInput) {
  const originalLength = output.length;
  const lineCount = output.split("\n").length;
  const useReduced = shouldUseReducedLimits(toolName, toolInput);
  const thresholds = useReduced ? REDUCED_OUTPUT_THRESHOLDS : OUTPUT_THRESHOLDS;
  let toolSpecific;
  switch (toolName) {
    case "Bash":
      toolSpecific = extractBashStats(output);
      break;
    case "Grep":
      toolSpecific = extractGrepStats(output, toolInput);
      break;
    case "Glob":
      toolSpecific = extractGlobStats(output);
      break;
  }
  if (originalLength <= thresholds.FULL_STORAGE_LIMIT) {
    return {
      stored_output: output,
      output_stats: {
        original_length: originalLength,
        line_count: lineCount,
        truncated: false,
        tool_specific: toolSpecific
      }
    };
  }
  const head = output.substring(0, thresholds.HEAD_SIZE);
  const tail = output.substring(output.length - thresholds.TAIL_SIZE);
  const omittedChars = originalLength - thresholds.HEAD_SIZE - thresholds.TAIL_SIZE;
  const storedOutput = `${head}
[... ${omittedChars} chars omitted ...]
${tail}`;
  return {
    stored_output: storedOutput,
    output_stats: {
      original_length: originalLength,
      line_count: lineCount,
      truncated: true,
      tool_specific: toolSpecific
    }
  };
}
function summarizeRead(input, response) {
  const filePath = input.file_path;
  const fileName = filePath.split("/").pop() || filePath;
  const ext = fileName.split(".").pop()?.toLowerCase();
  let typeHint = "";
  if (ext) {
    const typeMap = {
      ts: "TypeScript",
      js: "JavaScript",
      py: "Python",
      md: "Markdown",
      json: "JSON",
      yml: "YAML",
      yaml: "YAML",
      sql: "SQL",
      sh: "Shell script",
      rs: "Rust",
      go: "Go"
    };
    typeHint = typeMap[ext] || ext.toUpperCase();
  }
  return `Read ${fileName}${typeHint ? ` (${typeHint})` : ""}`;
}
function summarizeWrite(input, response) {
  const filePath = input.file_path;
  const fileName = filePath.split("/").pop() || filePath;
  const isNew = response?.toLowerCase().includes("created");
  return `${isNew ? "Created" : "Updated"} ${fileName}`;
}
function summarizeEdit(input, response) {
  const filePath = input.file_path;
  const fileName = filePath.split("/").pop() || filePath;
  const oldString = input.old_string || "";
  const newString = input.new_string || "";
  if (!oldString && !newString)
    return `Edited ${fileName}`;
  const oldLines = oldString.split("\n").map((l) => l.trim()).filter(Boolean);
  const newLines = newString.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const addedLines = newLines.filter((l) => !oldSet.has(l));
  const removedLines = oldLines.filter((l) => !newSet.has(l));
  for (const line of addedLines) {
    const funcMatch = line.match(
      /(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/
    );
    if (funcMatch)
      return `Edited ${fileName}: Added ${funcMatch[0].substring(0, 60)}`;
    const importMatch = line.match(/import\s+.+from\s+['"](.+?)['"]/);
    if (importMatch)
      return `Edited ${fileName}: Added import from '${importMatch[1]}'`;
    const typeMatch = line.match(/(?:interface|type)\s+(\w+)/);
    if (typeMatch)
      return `Edited ${fileName}: Added ${typeMatch[0]}`;
    if (line.includes("CREATE TABLE") || line.includes("ALTER TABLE")) {
      return `Edited ${fileName}: Schema ${line.substring(0, 50)}`;
    }
  }
  const netLines = newLines.length - oldLines.length;
  if (netLines > 3)
    return `Edited ${fileName}: Added ~${netLines} lines`;
  if (netLines < -3)
    return `Edited ${fileName}: Removed ~${Math.abs(netLines)} lines`;
  if (addedLines.length > 0) {
    const hint = addedLines[0].substring(0, 60);
    if (hint.length >= 8 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Edited ${fileName}: ${hint}`;
    }
  }
  if (removedLines.length > 0) {
    const hint = removedLines[0].substring(0, 60);
    if (hint.length >= 8 && !/^[\s{}\[\]"',;:()]+$/.test(hint)) {
      return `Edited ${fileName}: Changed ${hint}`;
    }
  }
  return `Edited ${fileName}`;
}
function summarizeBash(input, response) {
  const command = input.command || "";
  const commandPreview = command.length > 60 ? command.substring(0, 60) + "..." : command;
  if (command.startsWith("git ")) {
    return `Git: ${commandPreview.substring(4)}`;
  }
  if (command.startsWith("npm ") || command.startsWith("yarn ")) {
    return `Package manager: ${commandPreview}`;
  }
  if (command.startsWith("make ")) {
    return `Make: ${commandPreview.substring(5)}`;
  }
  return `Bash: ${commandPreview}`;
}
function summarizeGrep(input, response) {
  const pattern = input.pattern || "";
  const path3 = input.path || ".";
  const outputMode = input.output_mode || "files_with_matches";
  const patternPreview = pattern.length > 30 ? pattern.substring(0, 30) + "..." : pattern;
  if (outputMode === "count") {
    return `Grep count: "${patternPreview}" in ${path3}`;
  }
  return `Grep: "${patternPreview}" in ${path3}`;
}
function summarizeGlob(input, response) {
  const pattern = input.pattern || "";
  const path3 = input.path || ".";
  return `Glob: "${pattern}" in ${path3}`;
}
function summarizeTool(toolName, toolInput, toolResponse) {
  let summary = `${toolName} tool invocation`;
  if (!toolInput || typeof toolInput !== "object") {
    return summary;
  }
  const input = toolInput;
  switch (toolName) {
    case "Read":
      summary = summarizeRead(input, toolResponse);
      break;
    case "Write":
      summary = summarizeWrite(input, toolResponse);
      break;
    case "Edit":
      summary = summarizeEdit(input, toolResponse);
      break;
    case "Bash":
      summary = summarizeBash(input, toolResponse);
      break;
    case "Grep":
      summary = summarizeGrep(input, toolResponse);
      break;
    case "Glob":
      summary = summarizeGlob(input, toolResponse);
      break;
    default:
      summary = `${toolName} invocation`;
  }
  return summary;
}
function isNearNoOpEdit(input) {
  const oldStr = typeof input.old_string === "string" ? input.old_string : "";
  const newStr = typeof input.new_string === "string" ? input.new_string : "";
  if (!oldStr && !newStr)
    return false;
  if (oldStr.replace(/\s/g, "") === newStr.replace(/\s/g, ""))
    return true;
  const oldLines = oldStr.split("\n").map((l) => l.trim()).filter(Boolean);
  const newLines = newStr.split("\n").map((l) => l.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const addedLines = newLines.filter((l) => !oldSet.has(l));
  if (addedLines.length === 0)
    return true;
  return addedLines.every((l) => /^(\/\/|#|\/\*|\*|\*\/)/.test(l));
}
var TAG_FILE_RULES = [
  {
    tag: "auth",
    patterns: [
      /\/auth\//i,
      /\/authentication\//i,
      /\/authorization\//i,
      /auth\.(ts|js|py|go|rs)$/i,
      /login\.(ts|js|py|go|rs)$/i,
      /session\.(ts|js|py|go|rs)$/i,
      /jwt\.(ts|js|py|go|rs)$/i,
      /oauth/i,
      /token/i,
      /credential/i,
      /password/i,
      /ssh_config$/i,
      /\.pem$/i,
      /\.key$/i
    ]
  },
  {
    tag: "database",
    patterns: [
      /sqlite/i,
      /postgres/i,
      /mysql/i,
      /mongodb/i,
      /\/db\//i,
      /\/database\//i,
      /schema\.(ts|js|py|sql)$/i,
      /migration/i,
      /\.sql$/i,
      /query\.(ts|js|py)$/i
    ]
  },
  {
    tag: "testing",
    patterns: [
      /\.test\./i,
      /\.spec\./i,
      /__tests__\//i,
      /\/test\//i,
      /\/tests\//i,
      /\/e2e\//i
    ]
  },
  {
    tag: "git",
    patterns: [
      /\.gitignore$/i,
      /\.gitattributes$/i,
      /\.gitmodules$/i
    ]
  },
  {
    tag: "infra",
    patterns: [
      /Dockerfile$/i,
      /docker-compose/i,
      /\.github\//i,
      /\/k8s\//i,
      /\/kubernetes\//i,
      /\/ansible\//i,
      /\/terraform\//i,
      /\.tf$/i,
      /\.ya?ml$/,
      /\/molecule\//i,
      /ansible\.cfg$/i
    ]
  },
  {
    tag: "config",
    patterns: [
      /package\.json$/,
      /tsconfig/i,
      /pyproject\.toml$/,
      /Makefile$/,
      /\.env(\.\w+)?$/,
      /webpack\.config\./,
      /vite\.config\./,
      /eslint/,
      /prettier/,
      /Cargo\.toml$/,
      /go\.mod$/,
      /requirements.*\.txt$/,
      /setup\.py$/
    ]
  },
  {
    tag: "frontend",
    patterns: [
      /\/web\//i,
      /\/client\//i,
      /\/ui\//i,
      /\/components\//i,
      /\.html$/,
      /\.css$/,
      /\.scss$/,
      /\.tsx$/,
      /\.vue$/,
      /\.svelte$/
    ]
  },
  {
    tag: "api",
    patterns: [
      /\/api\//i,
      /\/routes\//i,
      /\/handlers\//i,
      /\/endpoints\//i,
      /router\.(ts|js|py|go)$/i,
      /server\.(ts|js|py|go)$/i,
      /\.http$/,
      /openapi/,
      /swagger/
    ]
  }
];
var TAG_BASH_RULES = [
  { tag: "git", pattern: /^git\s+/ },
  { tag: "git", pattern: /^gh\s+(pr|issue|repo|release|run|workflow|auth|gist)\b/ },
  { tag: "build", pattern: /\b(npm\s+(run\s+)?build|tsc\b|cargo\s+build|go\s+build|make\b|uv\s+build)\b/ },
  { tag: "testing", pattern: /\b(npm\s+(run\s+)?test|pytest\b|cargo\s+test|go\s+test|jest\b|vitest\b)\b/ },
  { tag: "deps", pattern: /\b(npm\s+install|npm\s+i\b|yarn\s+add|pip\s+install|pip3\s+install|cargo\s+add|go\s+get|uv\s+add|uv\s+install|poetry\s+add|poetry\s+install)\b/ },
  { tag: "build", pattern: /\buv\s+run\b/ },
  { tag: "infra", pattern: /\b(docker\s+(build|run|compose|push|pull|tag)|kubectl\b|helm\b|terraform\b)\b/ },
  { tag: "infra", pattern: /\b(ansible-playbook\b|ansible-galaxy\b|ansible\b)\b/ }
];
function inferTags(toolName, files, command) {
  const tags = /* @__PURE__ */ new Set();
  for (const file of files) {
    for (const rule of TAG_FILE_RULES) {
      if (rule.patterns.some((p) => p.test(file))) {
        tags.add(rule.tag);
      }
    }
  }
  if (toolName === "Bash" && command) {
    for (const rule of TAG_BASH_RULES) {
      if (rule.pattern.test(command)) {
        tags.add(rule.tag);
      }
    }
  }
  return [...tags];
}
var CONFIG_FILE_PATTERNS = [
  /package\.json$/,
  /tsconfig.*\.json$/,
  /docker-compose\.ya?ml$/,
  /Dockerfile$/,
  /\.env(\.\w+)?$/,
  /webpack\.config\./,
  /vite\.config\./,
  /eslint/,
  /prettier/,
  /Makefile$/,
  /Cargo\.toml$/,
  /go\.mod$/,
  /pyproject\.toml$/,
  /requirements.*\.txt$/
];
var TEST_FILE_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /__tests__\//,
  /test\//
];
var LOCK_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Cargo\.lock$/,
  /poetry\.lock$/
];
function calculateImportance(toolName, toolInput, toolResponse, filesTouched) {
  let score;
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const command = typeof input.command === "string" ? input.command : "";
  switch (toolName) {
    case "Edit": {
      const editInput = toolInput;
      const editFilePath = typeof editInput?.file_path === "string" ? editInput.file_path : "";
      if (editFilePath && isVersionBump(editFilePath)) {
        score = 0.4;
      } else if (editInput && isNearNoOpEdit(editInput)) {
        score = 0.15;
      } else {
        score = 0.8;
      }
      break;
    }
    case "Write":
      score = 0.8;
      break;
    case "Bash": {
      if (/^git\s+(commit|merge|rebase|cherry-pick)\b/.test(command)) {
        score = 0.9;
      } else if (/\b(npm\s+(run\s+)?test|pytest|cargo\s+test|go\s+test)\b/.test(command)) {
        score = 0.7;
      } else if (/\b(npm\s+(run\s+)?build|cargo\s+build|make\s+|go\s+build)\b/.test(command)) {
        score = 0.55;
      } else if (/\bnpm\s+version\b/.test(command)) {
        score = 0.4;
      } else if (/\b(npm\s+install|yarn\s+add|pip\s+install|cargo\s+add|go\s+get)\b/.test(command)) {
        score = 0.75;
      } else if (/^git\s+(status|log|diff|show)\b/.test(command)) {
        score = 0.35;
      } else if (/^(cat|head|tail)\s+/.test(command)) {
        score = 0.2;
      } else if (/^(ls|du|df|wc|find)\s/.test(command) || /^(ls|du|df)$/.test(command)) {
        score = 0.2;
      } else if (command.includes("sqlite3") || command.includes("psql")) {
        score = 0.35;
      } else if (/^python3?\s+-c\s+/.test(command)) {
        score = 0.3;
      } else {
        score = 0.5;
      }
      break;
    }
    case "Read":
      score = 0.3;
      break;
    case "Grep":
      score = 0.25;
      break;
    case "Glob":
      score = 0.2;
      break;
    case "NotebookEdit":
      score = 0.75;
      break;
    default:
      score = 0.5;
  }
  if (toolResponse) {
    const responseLower = toolResponse.toLowerCase();
    if (responseLower.includes("error") || responseLower.includes("failed") || responseLower.includes("exception") || responseLower.includes("fatal")) {
      score += 0.25;
    }
  }
  const allFiles = [
    ...filesTouched || [],
    typeof input.file_path === "string" ? input.file_path : "",
    typeof input.path === "string" ? input.path : ""
  ].filter(Boolean);
  for (const file of allFiles) {
    if (CONFIG_FILE_PATTERNS.some((p) => p.test(file))) {
      score += 0.15;
      break;
    }
  }
  for (const file of allFiles) {
    if (TEST_FILE_PATTERNS.some((p) => p.test(file))) {
      score += 0.1;
      break;
    }
  }
  for (const file of allFiles) {
    if (LOCK_FILE_PATTERNS.some((p) => p.test(file))) {
      score -= 0.3;
      break;
    }
  }
  score = Math.max(0, Math.min(1, score));
  let importance;
  if (score >= 0.65) {
    importance = "high";
  } else if (score >= 0.35) {
    importance = "medium";
  } else {
    importance = "low";
  }
  return { importance, importance_score: Math.round(score * 100) / 100 };
}
var BASH_SKIP_THRESHOLD = 0.15;
var MCP_SUMMARY_TRUNCATE_CHARS = 160;
var MCP_SUMMARY_SCORE_THRESHOLD = 0.3;
function processToolCapture(capture) {
  const sanitizedResponse = capture.tool_response ? sanitizeContent(capture.tool_response) : "";
  const extracted = extractOutput(
    sanitizedResponse,
    capture.tool_name,
    capture.tool_input
  );
  let summary = summarizeTool(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse
  );
  const filesTouched = extractFilesTouched(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse
  );
  const contentToEstimate = `${summary}
${extracted.stored_output}`;
  const tokenEstimate = estimateTokens(contentToEstimate);
  const { importance, importance_score } = calculateImportance(
    capture.tool_name,
    capture.tool_input,
    sanitizedResponse,
    filesTouched
  );
  if (capture.tool_name === "Bash" && importance_score < BASH_SKIP_THRESHOLD) {
    return { status: "skipped" };
  }
  if (capture.tool_name.startsWith("mcp__") && importance_score < MCP_SUMMARY_SCORE_THRESHOLD && summary.length > MCP_SUMMARY_TRUNCATE_CHARS) {
    summary = summary.substring(0, MCP_SUMMARY_TRUNCATE_CHARS) + "...";
  }
  const command = capture.tool_input && typeof capture.tool_input === "object" ? capture.tool_input.command : void 0;
  const tags = inferTags(capture.tool_name, filesTouched, command);
  const sanitizedToolInput = capture.tool_input ? { ...capture.tool_input } : void 0;
  if (sanitizedToolInput) {
    if (capture.tool_name === "Edit" || capture.tool_name === "Write") {
      delete sanitizedToolInput["old_string"];
      delete sanitizedToolInput["new_string"];
      delete sanitizedToolInput["content"];
    }
  }
  const metadata = {
    tool_input: sanitizedToolInput,
    stored_output: extracted.stored_output,
    output_stats: extracted.output_stats
  };
  return {
    session_id: capture.session_id,
    project: capture.project,
    tool_name: capture.tool_name,
    summary,
    files_touched: filesTouched,
    metadata,
    token_estimate: tokenEstimate,
    importance,
    importance_score,
    tags: tags.length > 0 ? tags : void 0,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/capture/remote-client.ts
async function post(client, path3, body) {
  const response = await fetch(`${client.url}${path3}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${client.token}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Remote ${path3} returned ${response.status}: ${text}`);
  }
  return response.json().catch(() => ({}));
}
async function remoteSaveObservation(client, observation) {
  await post(client, "/capture/observation", observation);
}

// src/utils/env.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir as homedir3 } from "node:os";
function loadDotEnv() {
  const envPath = join(homedir3(), ".claude-context", ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#"))
        continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1)
        continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[context-manager] Warning: could not read ~/.claude-context/.env:", err instanceof Error ? err.message : String(err));
    }
  }
}

// plugin/hooks/capture-tool.ts
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
  loadDotEnv();
  let storage = null;
  try {
    const inputStr = await readStdin();
    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch (parseError) {
      console.error("[context-manager] Invalid JSON input");
      await writeResponse({ status: "error", error: "Invalid JSON input" });
      return;
    }
    const remoteUrl = (process.env["CONTEXT_MANAGER_URL"] ?? "").trim();
    const remoteToken = (process.env["CONTEXT_MANAGER_TOKEN"] ?? "").trim();
    if (remoteUrl) {
      if (!remoteToken) {
        console.error(
          "[context-manager] CONTEXT_MANAGER_URL is set but CONTEXT_MANAGER_TOKEN is missing"
        );
        await writeResponse({ status: "error", error: "CONTEXT_MANAGER_TOKEN required when CONTEXT_MANAGER_URL is set" });
        return;
      }
      const obj = typeof rawInput === "object" && rawInput !== null ? rawInput : {};
      const sessionId = typeof obj.session_id === "string" ? obj.session_id.slice(0, 256) : "";
      const cwd = typeof obj.cwd === "string" ? obj.cwd.slice(0, 1024) : "";
      const toolName = typeof obj.tool_name === "string" ? obj.tool_name.slice(0, 128) : "";
      if (!sessionId || !cwd || !toolName) {
        await writeResponse({ status: "skipped" });
        return;
      }
      if (!shouldCaptureTool(toolName, obj.tool_input)) {
        await writeResponse({ status: "skipped" });
        return;
      }
      let toolResponse;
      if (typeof obj.tool_response === "string") {
        toolResponse = obj.tool_response;
      } else if (typeof obj.tool_response === "object" && obj.tool_response !== null) {
        const resp = obj.tool_response;
        const stdout = typeof resp.stdout === "string" ? resp.stdout : "";
        const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
        toolResponse = stderr ? `${stdout}
[stderr]
${stderr}` : stdout;
      }
      const result2 = processToolCapture({
        session_id: sessionId,
        project: cwd,
        tool_name: toolName,
        tool_input: obj.tool_input,
        tool_response: toolResponse
      });
      if ("status" in result2) {
        await writeResponse({ status: result2.status });
        return;
      }
      try {
        await remoteSaveObservation({ url: remoteUrl, token: remoteToken }, result2);
        await writeResponse({ status: "captured" });
      } catch (error) {
        console.error("[context-manager] Remote capture error:", error);
        await writeResponse({ status: "error" });
      }
      return;
    }
    const input = validatePostToolUseInput(rawInput);
    if (!shouldCaptureTool(input.tool_name, input.tool_input)) {
      await writeResponse({ status: "skipped" });
      return;
    }
    const result = processToolCapture({
      session_id: input.session_id,
      project: input.cwd,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: input.tool_response
    });
    if ("status" in result) {
      await writeResponse({ status: result.status });
      return;
    }
    const observation = result;
    storage = new SQLiteStorage();
    await storage.initialize();
    if (observation.files_touched.length > 0) {
      let surpriseAdj = 0;
      for (const file of observation.files_touched) {
        const count = await storage.incrementFileEncounter(file, input.cwd, input.tool_name);
        if (count === 1)
          surpriseAdj += 0.15;
        else if (count <= 3)
          surpriseAdj += 0.05;
        else if (count > 10)
          surpriseAdj -= 0.1;
      }
      surpriseAdj = Math.max(-0.15, Math.min(0.2, surpriseAdj));
      if (surpriseAdj !== 0) {
        const adjusted = Math.max(0, Math.min(1, observation.importance_score + surpriseAdj));
        observation.importance_score = Math.round(adjusted * 100) / 100;
        observation.importance = adjusted >= 0.65 ? "high" : adjusted >= 0.35 ? "medium" : "low";
      }
    }
    await storage.save(observation);
    await writeResponse({ status: "captured" });
  } catch (error) {
    console.error("[context-manager] Capture error:", error);
    await writeResponse({ status: "error" });
  } finally {
    if (storage)
      await storage.close();
  }
}
main();
