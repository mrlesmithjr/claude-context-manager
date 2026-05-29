#!/usr/bin/env node
import { createRequire as __ctxCreateRequire } from 'module';
const __ctxRequire = __ctxCreateRequire(import.meta.url);
let __betterSqlite3, __sqliteVec, __nativeModulesAvailable;
try {
  __betterSqlite3 = __ctxRequire('better-sqlite3');
  __sqliteVec = __ctxRequire('sqlite-vec');
  __nativeModulesAvailable = true;
} catch (_nativeErr) {
  __nativeModulesAvailable = false;
}

// shim:better-sqlite3
var better_sqlite3_default = __betterSqlite3;

// src/storage/sqlite.ts
import { homedir } from "os";
import { randomUUID } from "crypto";
import path from "path";
import { mkdirSync } from "fs";

// shim:sqlite-vec
var load = __sqliteVec?.load;
var sqlite_vec_default = __sqliteVec;

// src/utils/hash.ts
import { createHash } from "crypto";
function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
function l2DistanceToCosine(l2Distance) {
  return Math.max(0, Math.min(1, 1 - l2Distance * l2Distance / 2));
}

// src/utils/facts.ts
var FACT_CATEGORIES = [
  {
    name: "package_manager",
    values: ["npm", "pnpm", "yarn", "bun"],
    patterns: [
      /\b(use|using|switched?\s+to|running|with)\s+(npm|pnpm|yarn|bun)\b/i,
      /\b(npm|pnpm|yarn|bun)\s+(install|run|exec|workspace)\b/i
    ]
  },
  {
    name: "test_runner",
    values: ["jest", "vitest", "mocha", "pytest", "jasmine"],
    patterns: [
      /\b(use|using|switched?\s+to|running)\s+(jest|vitest|mocha|pytest|jasmine)\b/i,
      /\b(jest|vitest|mocha|pytest|jasmine)\s+(test|suite|config|run)\b/i
    ]
  },
  {
    name: "build_tool",
    values: ["webpack", "vite", "esbuild", "rollup", "parcel", "turbopack"],
    patterns: [
      /\b(use|using|switched?\s+to|building with)\s+(webpack|vite|esbuild|rollup|parcel|turbopack)\b/i,
      /\b(webpack|vite|esbuild|rollup|parcel|turbopack)\s+(config|build|bundle)\b/i
    ]
  },
  {
    name: "framework",
    values: ["express", "fastify", "hono", "koa", "nestjs", "next", "nuxt"],
    patterns: [
      /\b(use|using|switched?\s+to|built with)\s+(express|fastify|hono|koa|nestjs|next\.?js|nuxt)\b/i
    ]
  }
];
function detectFactType(summary) {
  if (!summary) return null;
  const lower = summary.toLowerCase();
  for (const cat of FACT_CATEGORIES) {
    for (const pattern of cat.patterns) {
      const match = pattern.exec(lower);
      if (match) {
        const capturedValue = match.slice(1).find((g) => g && cat.values.includes(g));
        if (capturedValue) {
          return { category: cat.name, value: capturedValue };
        }
      }
    }
  }
  return null;
}

// src/storage/sqlite.ts
var DEFAULT_DB_PATH = path.join(homedir(), ".claude-context", "context.db");
var GC_SESSION_SUMMARY = "[Session ended abnormally - no Stop hook fired]";
var _rawHalflife = parseFloat(process.env.CONTEXT_MANAGER_DECAY_HALFLIFE ?? "");
var DECAY_HALFLIFE_DAYS = Number.isFinite(_rawHalflife) && _rawHalflife >= 1 && _rawHalflife <= 3650 ? _rawHalflife : 60;
function recencyFactor(capturedAt) {
  const ageMs = Date.now() - new Date(capturedAt).getTime();
  const ageDays = ageMs / (1e3 * 60 * 60 * 24);
  if (ageDays <= 7) return 1.5;
  if (ageDays <= 30) return 1.1;
  if (ageDays <= 90) return 0.9;
  return 0.7;
}
function applyDecay(obs) {
  if (obs.pinned === 1) return obs.importance_score;
  const base = obs.importance_score;
  const ageMs = Date.now() - new Date(obs.created_at).getTime();
  const ageDays = ageMs / (1e3 * 60 * 60 * 24);
  const recencyScore = Math.pow(0.5, ageDays / DECAY_HALFLIFE_DAYS);
  const accessCount = obs.access_count ?? 0;
  const frequencyScore = Math.min(Math.log2(accessCount + 1) / Math.log2(101), 1);
  return base * 0.6 + recencyScore * 0.25 + frequencyScore * 0.15;
}
function extractTokens(text) {
  const seen = /* @__PURE__ */ new Set();
  const tokens = [];
  for (const tok of text.toLowerCase().split(/\W+/)) {
    if (tok.length >= 4 && !seen.has(tok)) {
      seen.add(tok);
      tokens.push(tok);
    }
  }
  return tokens;
}
function levenshtein(a, b) {
  const s = a.length <= 50 ? a : a.substring(0, 50);
  const t = b.length <= 50 ? b : b.substring(0, 50);
  const m = s.length;
  const n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        // deletion
        curr[j - 1] + 1,
        // insertion
        prev[j - 1] + cost
        // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
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
    this.migrateTagsToJson();
    this.migrateAddLessonType();
    this.migrateAddDecisionsTable();
    this.migrateAddPinnedAndAccessCount();
    this.migrateAddMetaTable();
    this.migrateAddBranchColumn();
    this.migrateAddSupersededBy();
    this.migrateAddTokenIndex();
    this.migrateAddBudgetIndex();
    this.migrateRepairManualSessionSummaries();
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
      if (match?.[1]) return match[1];
      const psqlMatch = summary.match(/^(Bash:\s*psql\b[^|;]*)/);
      if (psqlMatch?.[1]) return psqlMatch[1].substring(0, 40);
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
      tags: row.tags ? row.tags.startsWith("[") ? JSON.parse(row.tags) : row.tags.split(",").filter(Boolean) : void 0,
      content_hash: row.content_hash || void 0,
      lesson_type: row.lesson_type ?? null,
      pinned: row.pinned ?? 0,
      access_count: row.access_count ?? 0,
      branch: row.branch ?? null,
      superseded_by: row.superseded_by != null ? row.superseded_by : null,
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
        importance, importance_score, tags, content_hash, lesson_type, branch, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tagsValue = observation.tags && observation.tags.length > 0 ? JSON.stringify(observation.tags) : null;
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
      observation.lesson_type ?? null,
      observation.branch ?? null,
      observation.created_at
    );
    const insertedId = Number(info.lastInsertRowid);
    this.inferRelationships(insertedId, observation);
    this.db.prepare(`
      UPDATE observations SET pinned = 1
      WHERE id = ?
        AND (
          tags LIKE '%"decision"%' OR tags LIKE '%"lesson"%'
          OR lesson_type IS NOT NULL
        )
    `).run(insertedId);
    try {
      const fact = detectFactType(observation.summary ?? "");
      if (fact) {
        const cat = FACT_CATEGORIES.find((c) => c.name === fact.category);
        if (cat) {
          const conflictId = await this.findConflictingFact(
            observation.project,
            cat.values,
            fact.value,
            insertedId
          );
          if (conflictId !== null) {
            await this.markSuperseded(conflictId, insertedId);
          }
        }
      }
    } catch {
    }
    try {
      const tokens = extractTokens(observation.summary);
      if (tokens.length > 0) {
        this.addTokens(tokens);
      }
    } catch {
    }
    return insertedId;
  }
  async getRecent(project, limit = 50, offset = 0, toolName) {
    const safeLimit = Math.floor(Math.max(1, Math.min(500, Number(limit))));
    const safeOffset = Math.floor(Math.max(0, Number(offset)));
    const toolClause = toolName ? " AND tool_name = ?" : "";
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?${toolClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const params = [project + "%"];
    if (toolName) params.push(toolName);
    params.push(safeLimit, safeOffset);
    const rows = stmt.all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  async getWithinBudget(project, tokenBudget) {
    const effectiveBudget = Math.floor(tokenBudget * 0.8);
    const HIGH_IMPORTANCE_ALLOCATION = 0.6;
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
        AND is_compacted = 0
        AND superseded_by IS NULL
      ORDER BY importance_score DESC, created_at DESC
      LIMIT 500
    `);
    const rows = stmt.all(project + "%");
    const scoredRows = rows.map((row) => {
      const obs = this.mapRow(row);
      return { obs, score: applyDecay(obs) };
    });
    scoredRows.sort((a, b) => b.score - a.score);
    const highBudget = Math.floor(HIGH_IMPORTANCE_ALLOCATION * effectiveBudget);
    const highResults = [];
    const includedIds = /* @__PURE__ */ new Set();
    let highTokens = 0;
    for (const { obs, score } of scoredRows) {
      if (score < 0.65) continue;
      if (highTokens + obs.token_estimate > highBudget) continue;
      highResults.push(obs);
      if (obs.id !== void 0) includedIds.add(obs.id);
      highTokens += obs.token_estimate;
    }
    const remainingBudget = effectiveBudget - highTokens;
    const lowResults = [];
    let lowTokens = 0;
    for (const { obs } of scoredRows) {
      if (obs.id !== void 0 && includedIds.has(obs.id)) continue;
      if (lowTokens + obs.token_estimate > remainingBudget) continue;
      lowResults.push(obs);
      lowTokens += obs.token_estimate;
    }
    return [...highResults, ...lowResults];
  }
  async search(query, projectOrOptions) {
    const project = typeof projectOrOptions === "string" ? projectOrOptions : projectOrOptions?.project;
    const temporalMode = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.temporalMode ?? "neutral" : "neutral";
    const skipDecay = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.skipDecay ?? false : false;
    const branchFilter = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.branch : void 0;
    const includeSuperseded = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.include_superseded ?? false : false;
    const searchOffset = Math.floor(Math.max(0, Number(
      typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.offset ?? 0 : 0
    )));
    const importance = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.importance : void 0;
    const toolName = typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.toolName : void 0;
    let sql;
    let params;
    const ftsQuery = query.replace(/"/g, '""').split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t}"`).join(" ");
    const hasBranchFilter = branchFilter !== void 0 && branchFilter !== "*";
    const supersededClause = includeSuperseded ? "" : " AND o.superseded_by IS NULL";
    const importanceClause = importance ? " AND o.importance = ?" : "";
    const toolClause = toolName ? " AND o.tool_name = ?" : "";
    const limitParam = Math.floor(Math.max(1, Math.min(500, Number(
      typeof projectOrOptions === "object" && projectOrOptions !== null ? projectOrOptions.limit ?? 50 : 50
    ))));
    const paginationClause = searchOffset > 0 ? `LIMIT ${limitParam} OFFSET ${searchOffset}` : `LIMIT ${limitParam}`;
    if (project && hasBranchFilter) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ? AND o.branch = ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery, project + "%", branchFilter];
      if (importance) params.push(importance);
      if (toolName) params.push(toolName);
    } else if (project) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery, project + "%"];
      if (importance) params.push(importance);
      if (toolName) params.push(toolName);
    } else if (hasBranchFilter) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.branch = ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery, branchFilter];
      if (importance) params.push(importance);
      if (toolName) params.push(toolName);
    } else {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery];
      if (importance) params.push(importance);
      if (toolName) params.push(toolName);
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);
    let results = rows.map((row) => this.mapRow(row));
    if (results.length > 0) {
      const ids = results.map((o) => o.id).filter((id) => id != null);
      if (ids.length > 0) {
        const placeholders = ids.map(() => "?").join(", ");
        this.db.prepare(
          `UPDATE observations SET access_count = access_count + 1 WHERE id IN (${placeholders})`
        ).run(...ids);
      }
    }
    if (temporalMode === "current") {
      return results.map((obs) => ({
        ...obs,
        importance_score: (obs.importance_score ?? 0.5) * recencyFactor(obs.created_at)
      })).sort((a, b) => b.importance_score - a.importance_score);
    }
    if (temporalMode === "historical") {
      return results.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    }
    if (!skipDecay) {
      results = results.map((obs) => ({
        ...obs,
        importance_score: applyDecay(obs)
      }));
      results.sort((a, b) => b.importance_score - a.importance_score);
    }
    return results;
  }
  async searchByTag(tag, project, limit = 50, includeSuperseded = false) {
    const safeLimit = Math.floor(Math.max(1, Math.min(500, Number(limit))));
    const supersededClause = includeSuperseded ? "" : " AND o.superseded_by IS NULL";
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT o.* FROM observations o
        WHERE o.tags IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(o.tags) WHERE json_each.value = ?)
          AND o.project LIKE ?${supersededClause}
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [tag, project + "%", safeLimit];
    } else {
      sql = `
        SELECT o.* FROM observations o
        WHERE o.tags IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(o.tags) WHERE json_each.value = ?)${supersededClause}
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [tag, safeLimit];
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
    const budgetObs = await this.getWithinBudget(project ?? "", TOKEN_BUDGET);
    const budgetFillTokens = budgetObs.reduce((sum, o) => sum + o.token_estimate, 0);
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
    const compactedLast24hSql = project ? `SELECT COUNT(*) as count FROM observations WHERE is_compacted = 1 AND datetime(json_extract(metadata, '$.compacted_at')) > datetime('now', '-1 day') AND project LIKE ? || '%'` : `SELECT COUNT(*) as count FROM observations WHERE is_compacted = 1 AND datetime(json_extract(metadata, '$.compacted_at')) > datetime('now', '-1 day')`;
    const compactedLast24hRow = this.db.prepare(compactedLast24hSql).get(
      ...project ? [project] : []
    );
    const gcLast24hSql = project ? `SELECT COUNT(*) as count FROM sessions WHERE summary = ? AND ended_at > datetime('now', '-1 day') AND project LIKE ? || '%'` : `SELECT COUNT(*) as count FROM sessions WHERE summary = ? AND ended_at > datetime('now', '-1 day')`;
    const gcLast24hRow = this.db.prepare(gcLast24hSql).get(
      ...project ? [GC_SESSION_SUMMARY, project] : [GC_SESSION_SUMMARY]
    );
    const eligibleSql = project ? `SELECT COALESCE(SUM(cnt), 0) as count FROM (SELECT COUNT(*) as cnt FROM observations WHERE created_at < datetime('now', '-7 days') AND importance != 'high' AND is_compacted = 0 AND project LIKE ? || '%' GROUP BY session_id, tool_name HAVING COUNT(*) >= 3)` : `SELECT COALESCE(SUM(cnt), 0) as count FROM (SELECT COUNT(*) as cnt FROM observations WHERE created_at < datetime('now', '-7 days') AND importance != 'high' AND is_compacted = 0 GROUP BY session_id, tool_name HAVING COUNT(*) >= 3)`;
    const eligibleRow = this.db.prepare(eligibleSql).get(
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
      budget_fill_tokens: budgetFillTokens,
      importance_counts: importanceCounts,
      compacted_count: compactedRow?.compacted_count || 0,
      compacted_original_count: compactedRow?.original_count || 0,
      compacted_last_24h: compactedLast24hRow?.count || 0,
      sessions_gc_last_24h: gcLast24hRow?.count || 0,
      next_compaction_eligible: eligibleRow?.count || 0
    };
  }
  async createSession(sessionId, project, branch) {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, project, started_at, status, branch)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET project = excluded.project
    `);
    stmt.run(sessionId, project, (/* @__PURE__ */ new Date()).toISOString(), branch ?? null);
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
    if (!summary) return;
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
  async getSession(id) {
    const row = this.db.prepare(`
      SELECT id, project, started_at, ended_at, summary, summary_extended,
             source, status, last_checkpoint_at, branch
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(id);
    if (!row) return void 0;
    return {
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || void 0,
      summary: row.summary || void 0,
      summary_extended: row.summary_extended || void 0,
      source: row.source || void 0,
      status: row.status,
      last_checkpoint_at: row.last_checkpoint_at ?? void 0,
      branch: row.branch ?? null
    };
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
      status: row.status,
      branch: row.branch ?? null
    }));
  }
  async getDistinctBranches(project) {
    const rows = this.db.prepare(`
      SELECT DISTINCT branch FROM sessions
      WHERE project LIKE ? || '%' AND branch IS NOT NULL AND branch != ''
      ORDER BY branch ASC
    `).all(project);
    return rows.map((r) => r.branch);
  }
  async getRecentSessionsWithCounts(project, limit, offset, status, branch) {
    const statusClause = status ? "AND s.status = ?" : "";
    const branchClause = branch ? "AND s.branch = ?" : "";
    const sql = `
      SELECT
        s.id, s.project, s.started_at, s.ended_at,
        s.summary, s.summary_extended, s.status, s.branch,
        COUNT(o.id) AS observation_count,
        COALESCE(SUM(o.token_estimate), 0) AS total_tokens
      FROM sessions s
      LEFT JOIN observations o ON o.session_id = s.id
      WHERE s.project LIKE ? || '%'
        ${statusClause}
        ${branchClause}
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ? OFFSET ?
    `;
    const params = [project];
    if (status) params.push(status);
    if (branch) params.push(branch);
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || void 0,
      summary: row.summary || void 0,
      summary_extended: row.summary_extended || void 0,
      status: row.status,
      branch: row.branch ?? null,
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
        summary = ?
      WHERE status = 'active'
        AND ended_at IS NULL
        AND source != 'manual'
        AND (
          (last_checkpoint_at IS NOT NULL
            AND datetime(last_checkpoint_at / 1000, 'unixepoch') < ?)
          OR
          (last_checkpoint_at IS NULL
            AND started_at < ?)
        )
    `).run(GC_SESSION_SUMMARY, staleThresholdISO, staleThresholdISO);
    const staleManualSessions = this.db.prepare(`
      SELECT id FROM sessions
      WHERE status = 'active'
        AND ended_at IS NULL
        AND source = 'manual'
        AND (
          (last_checkpoint_at IS NOT NULL
            AND datetime(last_checkpoint_at / 1000, 'unixepoch') < ?)
          OR
          (last_checkpoint_at IS NULL
            AND started_at < ?)
        )
    `).all(staleThresholdISO, staleThresholdISO);
    const latestObsSummaryStmt = this.db.prepare(`
      SELECT summary FROM observations
      WHERE session_id = ? AND summary IS NOT NULL AND LENGTH(summary) > 0
      ORDER BY created_at DESC LIMIT 1
    `);
    const closeManualStmt = this.db.prepare(`
      UPDATE sessions
      SET status = 'complete', ended_at = datetime('now'), summary = ?
      WHERE id = ?
    `);
    const closeManual = this.db.transaction(() => {
      for (const row of staleManualSessions) {
        const obs = latestObsSummaryStmt.get(row.id);
        const derivedSummary = obs?.summary ? `Manual session: ${obs.summary.slice(0, 80)}` : "Manual session (no observations)";
        closeManualStmt.run(derivedSummary, row.id);
      }
    });
    closeManual();
    return staleResult.changes + staleManualSessions.length;
  }
  async vacuum(olderThanDays, staleSessionHours = 2, include_high = false) {
    let deletedObservations = 0;
    const closedStaleSessions = await this.closeStaleActiveSessions(staleSessionHours);
    if (olderThanDays) {
      const cutoffDate = /* @__PURE__ */ new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();
      const guardClause = include_high ? "" : " AND importance_score < 0.65 AND pinned = 0 AND lesson_type IS NULL";
      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?${guardClause}
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
    const { toolName, importance, olderThanDays, dryRun = false, include_high = false } = options;
    const conditions = [];
    const params = [];
    if (!include_high) {
      conditions.push("importance_score < 0.65");
      conditions.push("pinned = 0");
      conditions.push("lesson_type IS NULL");
    }
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
    const userFilterCount = (olderThanDays !== void 0 ? 1 : 0) + (toolName ? 1 : 0) + (importance ? 1 : 0);
    if (userFilterCount === 0) {
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
    try {
      const tokens = extractTokens(prompt.prompt_text);
      if (tokens.length > 0) {
        this.addTokens(tokens);
      }
    } catch {
    }
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
  async getFileTouchFrequency(project, days = 30, limit = 10) {
    const cutoff = /* @__PURE__ */ new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffISO = cutoff.toISOString();
    const base = `
      SELECT j.value AS file_path, COUNT(*) AS touch_count
      FROM observations
      JOIN json_each(observations.files_touched) AS j
        ON observations.files_touched IS NOT NULL
        AND observations.files_touched != '[]'
      WHERE observations.created_at >= ?
    `;
    let sql;
    let params;
    if (project) {
      sql = base + ` AND observations.project LIKE ?
        GROUP BY file_path ORDER BY touch_count DESC LIMIT ?`;
      params = [cutoffISO, project + "%", limit];
    } else {
      sql = base + `
        GROUP BY file_path ORDER BY touch_count DESC LIMIT ?`;
      params = [cutoffISO, limit];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows;
  }
  async getTagTrend(project, weeks = 12) {
    const cutoff = /* @__PURE__ */ new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffISO = cutoff.toISOString();
    const base = `
      SELECT
        DATE(observations.created_at, 'weekday 1', '-6 days') AS week,
        j.value AS tag,
        COUNT(*) AS count
      FROM observations
      JOIN json_each(observations.tags) AS j
        ON observations.tags IS NOT NULL
        AND observations.tags != '[]'
      WHERE observations.created_at >= ?
    `;
    let sql;
    let params;
    if (project) {
      sql = base + ` AND observations.project LIKE ?
        GROUP BY week, tag ORDER BY week ASC, count DESC
        LIMIT 500`;
      params = [cutoffISO, project + "%"];
    } else {
      sql = base + `
        GROUP BY week, tag ORDER BY week ASC, count DESC
        LIMIT 500`;
      params = [cutoffISO];
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows;
  }
  async getProjectVelocity(project, weeks = 12) {
    const cutoff = /* @__PURE__ */ new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffISO = cutoff.toISOString();
    const base = `
      SELECT
        DATE(created_at, 'weekday 1', '-6 days') AS week,
        project,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS observations
      FROM observations
      WHERE created_at >= ?
    `;
    let sql;
    let params;
    if (project) {
      sql = base + ` AND project LIKE ?
        GROUP BY week, project ORDER BY week ASC, observations DESC`;
      params = [cutoffISO, project + "%"];
    } else {
      sql = base + `
        GROUP BY week, project ORDER BY week ASC, observations DESC`;
      params = [cutoffISO];
    }
    const rows = this.db.prepare(sql).all(...params);
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
        AND is_compacted = 0
        AND superseded_by IS NULL
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
  async countObservations(project, tool, importance) {
    const conditions = [];
    const params = [];
    if (project) {
      conditions.push("project LIKE ?");
      params.push(project + "%");
    }
    if (tool) {
      conditions.push("tool_name = ?");
      params.push(tool);
    }
    if (importance) {
      conditions.push("importance = ?");
      params.push(importance);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) as count FROM observations ${where}`;
    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params);
    return result.count;
  }
  async countSessions(project, status, branch) {
    const conditions = [];
    const params = [];
    if (project) {
      conditions.push("project LIKE ?");
      params.push(project + "%");
    }
    if (status) {
      conditions.push("status = ?");
      params.push(status);
    }
    if (branch) {
      conditions.push("branch = ?");
      params.push(branch);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) as count FROM sessions ${where}`;
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
    const fetchFilesStmt = this.db.prepare(
      `SELECT files_touched FROM observations WHERE id IN (SELECT value FROM json_each(?))`
    );
    const compact = this.db.transaction(() => {
      for (const group of groups) {
        const idList = group.ids.split(",").map(Number);
        const fileRows = fetchFilesStmt.all(JSON.stringify(idList));
        const fileEntries = fileRows.flatMap((row) => {
          try {
            return JSON.parse(row.files_touched || "[]");
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
          JSON.stringify({ compacted_from: group.cnt, original_tokens: group.total_tokens, compacted_at: (/* @__PURE__ */ new Date()).toISOString() }),
          tokenEstimate,
          group.earliest
        );
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
    if (ids.length === 0) return;
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
    if (!this.vecEnabled) return;
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
    if (!this.vecEnabled) return false;
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
    if (!row) return false;
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
    if (!this.vecEnabled) return;
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
  /**
   * Migration: convert existing comma-separated tags to JSON array format.
   * json_each() requires a valid JSON array; rows already in JSON format (starting
   * with '[') are skipped. Example: 'database,git' -> '["database","git"]'
   */
  migrateTagsToJson() {
    const rows = this.db.prepare(
      `SELECT id, tags FROM observations WHERE tags IS NOT NULL AND tags NOT LIKE '[%'`
    ).all();
    if (rows.length === 0) return;
    const update = this.db.prepare(`UPDATE observations SET tags = ? WHERE id = ?`);
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const parts = row.tags.split(",").map((t) => t.trim()).filter(Boolean);
        update.run(JSON.stringify(parts), row.id);
      }
    });
    migrate();
    console.error(`[context-manager] Migrated ${rows.length} observations to JSON tags format`);
  }
  /**
   * Migration: add lesson_type column for error lesson classification.
   * lesson_type stores: 'error' | 'build_failure' | 'test_failure' | 'permission_denied' | NULL
   */
  migrateAddLessonType() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("lesson_type")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN lesson_type TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_lesson_type
      ON observations(project, lesson_type, created_at DESC)
      WHERE lesson_type IS NOT NULL
    `);
  }
  async getOrCreateManualSession(project) {
    const existing = this.db.prepare(`
      SELECT id, status FROM sessions
      WHERE project = ?
        AND source = 'manual'
        AND date(started_at, 'localtime') = date('now', 'localtime')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(project);
    if (existing) {
      if (existing.status === "complete") {
        this.db.prepare(
          `UPDATE sessions SET status = 'active', ended_at = NULL, summary = NULL WHERE id = ?`
        ).run(existing.id);
      }
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
    const { text: rawText, project, sessionId, importanceScore, tags, client } = params;
    const text = rawText.trim();
    if (!text) return void 0;
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
    const toolName = client ? `Manual:${client}` : "Manual";
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
      ) VALUES (?, ?, ?, ?, '[]', '{}', ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      project,
      toolName,
      text,
      tokenEstimate,
      importance,
      importanceScore,
      tags ? JSON.stringify(tags.split(",").map((t) => t.trim()).filter(Boolean)) : null,
      contentHash,
      createdAt
    );
    const obsId = Number(info.lastInsertRowid);
    this.db.prepare(`
      UPDATE observations SET pinned = 1
      WHERE id = ?
        AND (
          tags LIKE '%"decision"%' OR tags LIKE '%"lesson"%'
        )
    `).run(obsId);
    const sessionEnrichRow = this.db.prepare(
      `SELECT enriched_text FROM sessions WHERE id = ?`
    ).get(sessionId);
    const newEntry = !sessionEnrichRow.enriched_text ? `Actions: ${text}` : `${sessionEnrichRow.enriched_text}. ${text}`;
    this.db.prepare(
      `UPDATE sessions SET enriched_text = ? WHERE id = ?`
    ).run(newEntry.substring(0, 2e3), sessionId);
    return obsId;
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
    const sql = project ? `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL)) AND project LIKE ?` : `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL))`;
    const row = project ? this.db.prepare(sql).get(project + "%") : this.db.prepare(sql).get();
    return Promise.resolve(row.count);
  }
  countEmbeddedSessions(project) {
    const sql = project ? `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NOT NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL)) AND project LIKE ?` : `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NOT NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL))`;
    const row = project ? this.db.prepare(sql).get(project + "%") : this.db.prepare(sql).get();
    return Promise.resolve(row.count);
  }
  async getUnembeddedSessions(limit = 50, project) {
    let sql;
    let params;
    if (project) {
      sql = `
        SELECT * FROM sessions
        WHERE embedding IS NULL
          AND (
            status = 'complete'
            OR (source = 'manual' AND enriched_text IS NOT NULL)
          )
          AND project LIKE ?
        ORDER BY started_at DESC
        LIMIT ?
      `;
      params = [project + "%", limit];
    } else {
      sql = `
        SELECT * FROM sessions
        WHERE embedding IS NULL
          AND (
            status = 'complete'
            OR (source = 'manual' AND enriched_text IS NOT NULL)
          )
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
      enriched_text: row.enriched_text || void 0,
      source: row.source || void 0,
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
   *
   * Uses two queries instead of 1 + N: one for sessions, one bulk fetch
   * for all observations across all sessions grouped in JS. Previously
   * called getSessionObservations() once per session, causing an N+1
   * pattern on every SessionStart hook and context_list call.
   */
  async getRecentSessionsWithObservations(project, sessionLimit = 10) {
    const sessions = await this.getRecentSessions(project, sessionLimit);
    if (sessions.length === 0) return [];
    const ids = sessions.map((s) => s.id);
    const rows = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id IN (SELECT value FROM json_each(?))
        AND is_compacted = 0
        AND superseded_by IS NULL
      ORDER BY session_id, created_at ASC
    `).all(JSON.stringify(ids));
    const bySession = /* @__PURE__ */ new Map();
    for (const session of sessions) {
      bySession.set(session.id, []);
    }
    for (const row of rows) {
      const obs = this.mapRow(row);
      bySession.get(obs.session_id)?.push(obs);
    }
    return sessions.map((session) => ({
      session,
      observations: bySession.get(session.id) ?? []
    }));
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
    if (!row) return null;
    return this.mapRow(row);
  }
  /**
   * Get related observation references via observation_relationships.
   * Checks both source_id and target_id so direction does not matter.
   */
  getRelatedObservationRefs(id) {
    const rows = this.db.prepare(`
      SELECT
        CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END AS related_id,
        r.relationship
      FROM observation_relationships r
      WHERE r.source_id = ? OR r.target_id = ?
      LIMIT 5
    `).all(id, id, id);
    return Promise.resolve(rows.map((r) => ({ id: r.related_id, relationship: r.relationship })));
  }
  /**
   * Fetch full Observation objects for a list of IDs.
   * IDs that do not exist are silently skipped.
   * Results returned in ascending created_at order.
   */
  getObservationsByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    const safeIds = ids.map((id) => Math.trunc(id)).filter((id) => id > 0);
    if (safeIds.length === 0) return Promise.resolve([]);
    const placeholders = safeIds.map(() => "?").join(", ");
    const sql = `
      SELECT * FROM observations
      WHERE id IN (${placeholders})
      ORDER BY created_at ASC
    `;
    const rows = this.db.prepare(sql).all(...safeIds);
    const observations = rows.map((row) => this.mapRow(row));
    if (observations.length > 0) {
      const foundIds = observations.map((o) => o.id).filter((id) => id != null);
      if (foundIds.length > 0) {
        const idPlaceholders = foundIds.map(() => "?").join(", ");
        this.db.prepare(
          `UPDATE observations SET access_count = access_count + 1 WHERE id IN (${idPlaceholders})`
        ).run(...foundIds);
      }
    }
    return Promise.resolve(observations);
  }
  /**
   * Fetch neighboring observations in the same session around a given ID.
   * Returns null if the target ID does not exist.
   */
  getObservationNeighbors(id, window) {
    const targetRow = this.db.prepare(`
      SELECT * FROM observations WHERE id = ?
    `).get(id);
    if (!targetRow) return Promise.resolve(null);
    const target = this.mapRow(targetRow);
    const sessionId = targetRow.session_id;
    const capturedAt = targetRow.created_at;
    const beforeRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(sessionId, capturedAt, capturedAt, id, window);
    const before = beforeRows.map((row) => this.mapRow(row)).reverse();
    const afterRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, capturedAt, capturedAt, id, window);
    const after = afterRows.map((row) => this.mapRow(row));
    return Promise.resolve({ before, target, after });
  }
  async getLessons(project, query, lessonType, limit = 20, since) {
    const effectiveLimit = Math.max(1, Math.min(50, limit));
    let sql;
    const params = [];
    if (project) {
      sql = `
        SELECT * FROM observations
        WHERE project LIKE ? || '%'
          AND lesson_type IS NOT NULL
          AND (? IS NULL OR lesson_type = ?)
          AND (? IS NULL OR summary LIKE '%' || ? || '%')
          AND (? IS NULL OR created_at >= ?)
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params.push(
        project,
        lessonType ?? null,
        lessonType ?? null,
        query ?? null,
        query ?? null,
        since ?? null,
        since ?? null,
        effectiveLimit
      );
    } else {
      sql = `
        SELECT * FROM observations
        WHERE lesson_type IS NOT NULL
          AND (? IS NULL OR lesson_type = ?)
          AND (? IS NULL OR summary LIKE '%' || ? || '%')
          AND (? IS NULL OR created_at >= ?)
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params.push(
        lessonType ?? null,
        lessonType ?? null,
        query ?? null,
        query ?? null,
        since ?? null,
        since ?? null,
        effectiveLimit
      );
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.mapRow(row));
  }
  /**
   * Migration: add pinned and access_count columns to observations.
   *
   * pinned = 1 marks an observation as exempt from time-weighted decay.
   * Auto-set at capture time for observations tagged 'decision' or 'lesson',
   * or where lesson_type IS NOT NULL.
   *
   * access_count tracks how often an observation has been returned in search
   * results. Used by applyDecay() to give a frequency bonus to frequently-retrieved
   * observations.
   */
  migrateAddPinnedAndAccessCount() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("pinned")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columnNames.has("access_count")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_pinned
      ON observations(project, pinned) WHERE pinned = 1
    `);
  }
  /**
   * Migration: add decisions table for first-class decision tracking.
   * Uses CREATE TABLE IF NOT EXISTS (idempotent on every startup).
   * Also creates the FTS5 virtual table and the project index.
   */
  migrateAddDecisionsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        project TEXT NOT NULL,
        decision_text TEXT NOT NULL,
        context TEXT,
        decision_number INTEGER,
        captured_at TEXT NOT NULL,
        importance_score REAL DEFAULT 0.7,
        tags TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_decisions_project
      ON decisions(project, captured_at DESC)
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        decision_text,
        context,
        content='decisions',
        content_rowid='id'
      )
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(rowid, decision_text, context)
        VALUES (new.id, COALESCE(new.decision_text, ''), COALESCE(new.context, ''));
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, decision_text, context)
        VALUES('delete', old.id, COALESCE(old.decision_text, ''), COALESCE(old.context, ''));
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, decision_text, context)
        VALUES('delete', old.id, COALESCE(old.decision_text, ''), COALESCE(old.context, ''));
        INSERT INTO decisions_fts(rowid, decision_text, context)
        VALUES (new.id, COALESCE(new.decision_text, ''), COALESCE(new.context, ''));
      END
    `);
  }
  /**
   * Save a decision and update the FTS5 index.
   */
  async saveDecision(decision) {
    const info = this.db.prepare(`
      INSERT INTO decisions (
        session_id, project, decision_text, context,
        decision_number, captured_at, importance_score, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.session_id,
      decision.project,
      decision.decision_text,
      decision.context ?? null,
      decision.decision_number ?? null,
      decision.captured_at,
      decision.importance_score ?? 0.7,
      decision.tags ?? null
    );
  }
  /**
   * Search decisions for a project. Without a query, returns recent decisions ordered
   * by captured_at DESC. With a query, uses FTS5 to filter.
   */
  async searchDecisions(project, query, limit = 20) {
    const effectiveLimit = Math.max(1, Math.min(50, limit));
    let rows;
    if (query && query.trim().length > 0) {
      const ftsQuery = query.trim().replace(/"/g, '""').split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t}"`).join(" ");
      rows = this.db.prepare(`
        SELECT d.* FROM decisions d
        JOIN decisions_fts f ON d.id = f.rowid
        WHERE d.project LIKE ? || '%'
          AND decisions_fts MATCH ?
        ORDER BY d.captured_at DESC
        LIMIT ?
      `).all(project, ftsQuery, effectiveLimit);
    } else {
      rows = this.db.prepare(`
        SELECT * FROM decisions
        WHERE project LIKE ? || '%'
        ORDER BY captured_at DESC
        LIMIT ?
      `).all(project, effectiveLimit);
    }
    return rows.map((row) => ({
      id: row["id"],
      session_id: row["session_id"],
      project: row["project"],
      decision_text: row["decision_text"],
      context: row["context"] ?? null,
      decision_number: row["decision_number"] ?? null,
      captured_at: row["captured_at"],
      importance_score: row["importance_score"] ?? 0.7,
      tags: row["tags"] ?? null
    }));
  }
  /**
   * Get the next sequential decision number for a project.
   * Returns 1 when no decisions exist yet for the project.
   */
  async getNextDecisionNumber(project) {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(decision_number), 0) + 1 AS next_num
      FROM decisions
      WHERE project LIKE ? || '%'
    `).get(project);
    return row?.next_num ?? 1;
  }
  /**
   * Migration: add meta table for lightweight key-value persistence.
   * Idempotent, uses CREATE TABLE IF NOT EXISTS.
   */
  migrateAddMetaTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }
  /**
   * Migration: add branch column to observations and sessions.
   * Guards each ALTER TABLE with PRAGMA table_info to be idempotent.
   * The partial index on observations is always idempotent via IF NOT EXISTS.
   */
  migrateAddBranchColumn() {
    const obsColumns = this.db.prepare("PRAGMA table_info(observations)").all();
    const obsColumnNames = new Set(obsColumns.map((c) => c.name));
    if (!obsColumnNames.has("branch")) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN branch TEXT`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_branch
      ON observations(project, branch) WHERE branch IS NOT NULL
    `);
    const sessColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
    const sessColumnNames = new Set(sessColumns.map((c) => c.name));
    if (!sessColumnNames.has("branch")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT`);
    }
  }
  /**
   * Get observations suitable for reflection analysis.
   * Returns high-importance observations from the lookback window ordered by
   * importance descending then recency descending, capped at 500.
   */
  async getObservationsForReflection(project, lookbackDays, minImportance) {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1e3).toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ? || '%'
        AND importance_score >= ?
        AND created_at >= ?
        AND is_compacted = 0
        AND superseded_by IS NULL
      ORDER BY importance_score DESC, created_at DESC
      LIMIT 500
    `).all(project, minImportance, since);
    return rows.map((row) => this.mapRow(row));
  }
  /**
   * Get the ISO date string of the last reflection run for a project.
   * Returns null when no reflection has been run yet.
   */
  async getLastReflectionDate(project) {
    const key = `reflection:${project}`;
    const row = this.db.prepare(
      `SELECT value FROM meta WHERE key = ?`
    ).get(key);
    return row?.value ?? null;
  }
  /**
   * Store the ISO date string of a completed reflection run for a project.
   */
  async setLastReflectionDate(project, date) {
    const key = `reflection:${project}`;
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, date);
  }
  /**
   * Migration: add superseded_by column for fact supersession detection.
   * Guards the ALTER TABLE with PRAGMA table_info — safe to run on every startup.
   * The partial index uses CREATE INDEX IF NOT EXISTS (idempotent).
   */
  migrateAddSupersededBy() {
    const columns = this.db.prepare("PRAGMA table_info(observations)").all();
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has("superseded_by")) {
      this.db.exec(
        `ALTER TABLE observations ADD COLUMN superseded_by INTEGER REFERENCES observations(id) ON DELETE SET NULL`
      );
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_superseded
      ON observations(superseded_by) WHERE superseded_by IS NOT NULL
    `);
  }
  /**
   * Find the most recent non-superseded observation in the same project that mentions
   * a value from the same fact category but NOT the newly detected value.
   * Used to detect when a new stack preference contradicts an older one.
   *
   * Returns at most one row (the most recent conflict). Parameterized — no SQL
   * injection risk; value strings are sourced from the static FACT_CATEGORIES
   * array, not user input.
   */
  async findConflictingFact(project, categoryValues, newValue, currentObservationId) {
    if (categoryValues.length === 0) return null;
    const likeClauses = categoryValues.map(() => `summary LIKE ?`).join(" OR ");
    const selfExclusion = currentObservationId != null ? "AND id != ?" : "";
    const sql = `
      SELECT id FROM observations
      WHERE project LIKE ? || '%'
        AND superseded_by IS NULL
        AND (${likeClauses})
        AND summary NOT LIKE ?
        ${selfExclusion}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const likeParams = categoryValues.map((v) => `%${v}%`);
    const excludeParam = `%${newValue}%`;
    const params = [project, ...likeParams, excludeParam];
    if (currentObservationId != null) params.push(currentObservationId);
    const rows = this.db.prepare(sql).all(...params);
    return rows[0]?.id ?? null;
  }
  /**
   * Mark an observation as superseded by a newer one.
   * Sets superseded_by = newId on the row with id = oldId.
   */
  async markSuperseded(oldId, newId) {
    this.db.prepare(
      `UPDATE observations SET superseded_by = ? WHERE id = ?`
    ).run(newId, oldId);
  }
  /**
   * Migration: create the token_index table for fuzzy search correction.
   * Safe to run on existing databases (uses IF NOT EXISTS).
   */
  migrateAddTokenIndex() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_index (
        token TEXT PRIMARY KEY,
        frequency INTEGER DEFAULT 1
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_index_frequency ON token_index(frequency DESC);
    `);
  }
  /**
   * Add partial index for getWithinBudget() query plan.
   *
   * Root cause of the full-table scan: idx_observations_project_score covers
   * (project, importance_score DESC, created_at DESC) but does not include
   * is_compacted or superseded_by. To evaluate those filters, SQLite must
   * fetch the full row for every index entry — a random-read overhead that
   * the cost model rates worse than a sequential table scan when the filters
   * have low selectivity (most observations are active and non-superseded).
   *
   * A partial index bakes the boolean conditions into the index definition.
   * The planner sees only pre-filtered rows, eliminating the per-row fetch
   * for those predicates and enabling a direct range scan on (project,
   * importance_score, created_at).
   *
   * USE TEMP B-TREE FOR ORDER BY remains because the LIKE range scan on
   * project cannot guarantee sort order across multiple prefix values.
   * This is expected and acceptable; the B-tree sort runs on the already-
   * narrowed partial index rowset, not the full table.
   *
   * The existing idx_observations_project_score is retained -- it serves
   * query paths that sort by importance_score without the boolean equality
   * predicates (tag search, semantic search paths). The partial index takes
   * precedence for getWithinBudget() because the planner prefers the
   * narrower rowset.
   */
  migrateAddBudgetIndex() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_budget
      ON observations(project, importance_score DESC, created_at DESC)
      WHERE is_compacted = 0 AND superseded_by IS NULL
    `);
  }
  /**
   * One-time idempotent migration: repair manual sessions whose summary was set
   * to the GC sentinel by a prior version of closeStaleActiveSessions(). The
   * condition `summary = GC_SESSION_SUMMARY` makes re-runs a no-op for any
   * session already repaired.
   */
  migrateRepairManualSessionSummaries() {
    const staleSessions = this.db.prepare(`
      SELECT id FROM sessions
      WHERE source = 'manual'
        AND summary = ?
    `).all(GC_SESSION_SUMMARY);
    if (staleSessions.length === 0) return;
    const latestObsSummaryStmt = this.db.prepare(`
      SELECT summary FROM observations
      WHERE session_id = ? AND summary IS NOT NULL AND LENGTH(summary) > 0
      ORDER BY created_at DESC LIMIT 1
    `);
    const updateStmt = this.db.prepare(`
      UPDATE sessions SET summary = ? WHERE id = ?
    `);
    const repair = this.db.transaction(() => {
      for (const row of staleSessions) {
        const obs = latestObsSummaryStmt.get(row.id);
        const derivedSummary = obs?.summary ? `Manual session: ${obs.summary.slice(0, 80)}` : "Manual session (no observations)";
        updateStmt.run(derivedSummary, row.id);
      }
    });
    repair();
  }
  /**
   * Add tokens to the token_index, incrementing frequency on conflict.
   * Runs as a transaction for efficiency. Tokens are already normalized.
   */
  addTokens(tokens) {
    if (tokens.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO token_index(token, frequency) VALUES(?, 1)
       ON CONFLICT(token) DO UPDATE SET frequency = frequency + 1`
    );
    const runAll = this.db.transaction((toks) => {
      for (const tok of toks) {
        upsert.run(tok);
      }
    });
    runAll(tokens);
  }
  /**
   * Find the closest known token to the input using Levenshtein distance.
   * Queries candidates with length within 2 of the input, frequency >= minFrequency,
   * and token != the input (exact matches don't need correction).
   * Returns the best candidate with edit distance <= 2, or null.
   */
  findClosestToken(token, minFrequency = 3) {
    if (token.length > 50) return null;
    const minLen = Math.max(1, token.length - 2);
    const maxLen = token.length + 2;
    const rows = this.db.prepare(
      `SELECT token FROM token_index
       WHERE frequency >= ? AND length(token) BETWEEN ? AND ? AND token != ?
       LIMIT 200`
    ).all(minFrequency, minLen, maxLen, token);
    let bestToken = null;
    let bestDist = 3;
    for (const row of rows) {
      const dist = levenshtein(token, row.token);
      if (dist < bestDist) {
        bestDist = dist;
        bestToken = row.token;
      }
    }
    return bestToken;
  }
  close() {
    this.db.close();
    return Promise.resolve();
  }
};

// src/utils/env.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir as homedir2 } from "node:os";
function loadDotEnv() {
  const envPath = join(homedir2(), ".claude-context", ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
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

// src/utils/logger.ts
import { appendFileSync, mkdirSync as mkdirSync2, statSync, readFileSync as readFileSync2, writeFileSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir3 } from "os";
var LOG_DIR = join2(homedir3(), ".claude-context", "logs");
var MAX_LOG_SIZE = 1 * 1024 * 1024;
var KEEP_SIZE = 500 * 1024;
function isDebugEnabled() {
  return process.env.CONTEXT_MANAGER_DEBUG === "1";
}
function rotateIfNeeded(logFile) {
  try {
    const stats = statSync(logFile);
    if (stats.size > MAX_LOG_SIZE) {
      const content = readFileSync2(logFile, "utf8");
      const trimmed = content.slice(content.length - KEEP_SIZE);
      const firstNewline = trimmed.indexOf("\n");
      writeFileSync(logFile, firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed);
    }
  } catch {
  }
}
function createDebugLogger(logFileName) {
  const logFile = join2(LOG_DIR, logFileName);
  return (label, data) => {
    if (!isDebugEnabled()) return;
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

// plugin/hooks/file-context.ts
import path2 from "path";
var debugLog = createDebugLogger("file-context-hook-debug.log");
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
function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
async function main() {
  loadDotEnv();
  const remoteUrl = (process.env["CONTEXT_MANAGER_URL"] ?? "").trim();
  if (remoteUrl) {
    debugLog("REMOTE_MODE_SKIP", { reason: "file-context injection skipped in remote mode" });
    await writeResponse({});
    return;
  }
  if (!__nativeModulesAvailable) {
    console.error(
      "[context-manager] No server configured and native SQLite modules are not available. Run 'make server-quickstart' (macOS) or 'make server-start' (Docker), then restart Claude Code."
    );
    await writeResponse({});
    return;
  }
  let storage = null;
  try {
    const inputStr = await readStdin();
    let rawInput;
    try {
      rawInput = JSON.parse(inputStr);
    } catch {
      debugLog("PARSE_ERROR", "invalid JSON input");
      await writeResponse({});
      return;
    }
    const obj = typeof rawInput === "object" && rawInput !== null ? rawInput : {};
    const sessionId = typeof obj.session_id === "string" ? obj.session_id.slice(0, 256) : "";
    const cwd = typeof obj.cwd === "string" ? obj.cwd.slice(0, 1024) : "";
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : "";
    if (toolName !== "Read") {
      await writeResponse({});
      return;
    }
    const toolInput = typeof obj.tool_input === "object" && obj.tool_input !== null ? obj.tool_input : {};
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
    if (!sessionId || !cwd || !filePath) {
      await writeResponse({});
      return;
    }
    debugLog("FILE_CONTEXT_REQUEST", { sessionId, cwd, filePath });
    storage = new SQLiteStorage();
    await storage.initialize();
    const escapedPath = filePath.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const likePattern = `%${escapedPath}%`;
    const alreadySeen = await storage.hasSessionSeenFile(sessionId, likePattern);
    if (alreadySeen) {
      debugLog("FILE_CONTEXT_SKIP_ALREADY_SEEN", { filePath, sessionId });
      await writeResponse({});
      return;
    }
    const history = await storage.getFileHistory(filePath, cwd, sessionId, 3);
    if (history.length < 2) {
      debugLog("FILE_CONTEXT_SKIP_INSUFFICIENT", { sessionId, filePath, count: history.length });
      await writeResponse({});
      return;
    }
    const fileName = path2.basename(filePath);
    const entries = history.map((obs) => {
      const dateLabel = formatDate(obs.created_at);
      const raw = obs.summary.replace(/\n+/g, " ").trim();
      const snippet = raw.length > 80 ? raw.substring(0, 80) + "..." : raw;
      return dateLabel ? `${snippet} (${dateLabel})` : snippet;
    });
    const count = history.length;
    const sessionWord = count === 1 ? "session" : "sessions";
    const context = `[file history: ${fileName} - ${count} prior ${sessionWord}: ${entries.join(", ")}]`;
    debugLog("FILE_CONTEXT_INJECT", { sessionId, filePath, count });
    await writeResponse({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context
      }
    });
  } catch (error) {
    debugLog("FILE_CONTEXT_ERROR", String(error));
    console.error("[context-manager] file-context hook error:", error);
    await writeResponse({});
  } finally {
    if (storage) await storage.close();
  }
}
main();
