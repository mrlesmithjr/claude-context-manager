#!/usr/bin/env node
import { createRequire as __createRequire } from 'module';
const __require = __createRequire(import.meta.url);
const __betterSqlite3 = __require('__homedir__/Projects/Personal/claude-context-manager/node_modules/better-sqlite3');

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
  }
  async save(observation) {
    const summaryPrefix = observation.summary.substring(0, 60);
    let dedupeWindowMs = 6e4;
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
    } else if (observation.tool_name === "Edit") {
      dedupeWindowMs = 12e4;
      crossSession = false;
    }
    const windowStart = new Date(Date.now() - dedupeWindowMs).toISOString();
    const duplicateCheck = crossSession ? this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE project = ?
            AND substr(summary, 1, 60) = ?
            AND created_at > ?
        `) : this.db.prepare(`
          SELECT COUNT(*) as count FROM observations
          WHERE session_id = ?
            AND substr(summary, 1, 60) = ?
            AND created_at > ?
        `);
    const checkKey = crossSession ? observation.project : observation.session_id;
    const result = duplicateCheck.get(checkKey, summaryPrefix, windowStart);
    if (result.count > 0) {
      return;
    }
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
  async getRecent(project, limit) {
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(project + "%", limit);
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || void 0,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      token_estimate: row.token_estimate,
      created_at: row.created_at
    }));
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
      if (totalTokens + row.token_estimate > effectiveBudget) {
        break;
      }
      results.push({
        id: row.id,
        session_id: row.session_id,
        project: row.project,
        package: row.package || void 0,
        tool_name: row.tool_name,
        summary: row.summary,
        files_touched: JSON.parse(row.files_touched || "[]"),
        metadata: JSON.parse(row.metadata || "{}"),
        token_estimate: row.token_estimate,
        created_at: row.created_at
      });
      totalTokens += row.token_estimate;
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
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || void 0,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      token_estimate: row.token_estimate,
      created_at: row.created_at
    }));
  }
  async getStats(project) {
    const TOKEN_BUDGET2 = parseInt(
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
    const typicalInjection = Math.min(avgRecentTokens, TOKEN_BUDGET2);
    return {
      total_observations: baseRow.total_observations,
      total_sessions: sessionRow.count,
      oldest_observation: baseRow.oldest_observation,
      newest_observation: baseRow.newest_observation,
      total_tokens: baseRow.total_tokens || 0,
      avg_tokens_per_observation: Math.round(baseRow.avg_tokens || 0),
      avg_tokens_per_session: avgTokensPerSession,
      tokens_by_tool: tokensByTool,
      token_budget: TOKEN_BUDGET2,
      typical_injection_tokens: typicalInjection
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
    if (olderThanDays) {
      const cutoffDate = /* @__PURE__ */ new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();
      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?
      `);
      const result = stmt.run(cutoffISO);
      return result.changes;
    }
    this.db.exec("VACUUM");
    return 0;
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
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      package: row.package || void 0,
      tool_name: row.tool_name,
      summary: row.summary,
      files_touched: JSON.parse(row.files_touched || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
      token_estimate: row.token_estimate,
      created_at: row.created_at
    }));
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
  path2.join(homedir2(), "Obsidian"),
  // Obsidian vaults
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
function generateSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
function validateSessionStartInput(input) {
  const obj = typeof input === "object" && input !== null ? input : {};
  const session_id = typeof obj.session_id === "string" && obj.session_id.length > 0 ? obj.session_id : generateSessionId();
  const rawCwd = typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : process.cwd();
  let validatedCwd;
  try {
    validatedCwd = validateProjectPath(rawCwd);
  } catch {
    validatedCwd = rawCwd;
  }
  return {
    session_id,
    cwd: validatedCwd
  };
}

// src/inject/builder.ts
function calculateTimeAgo(dateStr) {
  const createdDate = new Date(dateStr);
  const now = /* @__PURE__ */ new Date();
  const diffMs = now.getTime() - createdDate.getTime();
  const diffHours = Math.floor(diffMs / (1e3 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  if (diffHours < 1) {
    const diffMinutes = Math.floor(diffMs / (1e3 * 60));
    return diffMinutes <= 1 ? "just now" : `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    const diffWeeks = Math.floor(diffDays / 7);
    return `${diffWeeks}w ago`;
  }
}
function formatObservation(obs, index) {
  const fileInfo = obs.files_touched.length > 0 ? ` (${obs.files_touched.join(", ")})` : "";
  const timeAgo = calculateTimeAgo(obs.created_at);
  return `${index + 1}. [${timeAgo}] ${obs.summary}${fileInfo}`;
}
function groupBySubProject(observations, basePath) {
  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const groups = /* @__PURE__ */ new Map();
  for (const obs of observations) {
    let groupKey;
    if (obs.project === normalizedBase) {
      groupKey = "_root";
    } else if (obs.project.startsWith(normalizedBase + "/")) {
      const relativePath = obs.project.substring(normalizedBase.length + 1);
      const parts = relativePath.split("/");
      groupKey = parts[0] || "_root";
    } else {
      groupKey = "_other";
    }
    let existing = groups.get(groupKey);
    if (!existing) {
      existing = [];
      groups.set(groupKey, existing);
    }
    existing.push(obs);
  }
  return groups;
}
function buildContext(observations, basePath, summary, previouslyContext) {
  if (observations.length === 0 && !summary && !previouslyContext) {
    return "";
  }
  const totalTokens = observations.reduce(
    (sum, obs) => sum + obs.token_estimate,
    0
  );
  const lines = [];
  lines.push("<claude-context>");
  lines.push("## Previous Context for This Project");
  lines.push("");
  if (previouslyContext) {
    lines.push("### Previously");
    lines.push(previouslyContext);
    lines.push("");
  }
  if (summary) {
    lines.push("### Recent Session Summary");
    lines.push(summary);
    lines.push("");
  }
  if (observations.length > 0) {
    const groups = groupBySubProject(observations, basePath);
    const hasMultipleProjects = groups.size > 1 || groups.size === 1 && !groups.has("_root");
    if (hasMultipleProjects) {
      lines.push(
        `### Recent Activity by Project (${observations.length} observations, ~${totalTokens} tokens)`
      );
      lines.push("");
      const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
        const aNewest = a[1][0]?.created_at || "";
        const bNewest = b[1][0]?.created_at || "";
        return bNewest.localeCompare(aNewest);
      });
      for (const [groupKey, groupObservations] of sortedGroups) {
        if (groupKey === "_root") {
          lines.push(
            `#### Root Directory (${groupObservations.length} observations)`
          );
        } else if (groupKey === "_other") {
          lines.push(`#### Other (${groupObservations.length} observations)`);
        } else {
          lines.push(`#### ${groupKey} (${groupObservations.length} observations)`);
        }
        lines.push("");
        for (let i = 0; i < groupObservations.length; i++) {
          const obs = groupObservations[i];
          if (obs) {
            lines.push(formatObservation(obs, i));
          }
        }
        lines.push("");
      }
    } else {
      lines.push(
        `### Recent Activity (${observations.length} observations, ~${totalTokens} tokens)`
      );
      lines.push("");
      for (let i = 0; i < observations.length; i++) {
        const obs = observations[i];
        if (obs) {
          lines.push(formatObservation(obs, i));
        }
      }
      lines.push("");
    }
  }
  lines.push("</claude-context>");
  return lines.join("\n");
}
function buildVisibilityMessage(observations, basePath) {
  if (observations.length === 0) {
    return "[context-manager] No previous context found for this project";
  }
  const totalTokens = observations.reduce(
    (sum, obs) => sum + obs.token_estimate,
    0
  );
  const lines = [];
  if (basePath) {
    const groups = groupBySubProject(observations, basePath);
    const hasMultipleProjects = groups.size > 1 || groups.size === 1 && !groups.has("_root");
    if (hasMultipleProjects) {
      const projectCount = Array.from(groups.keys()).filter(
        (key) => key !== "_root" && key !== "_other"
      ).length;
      const projectCounts = Array.from(groups.entries()).map(([key, obs]) => {
        const label = key === "_root" ? "Root" : key === "_other" ? "Other" : key;
        return `${label}: ${obs.length}`;
      }).join(", ");
      lines.push(
        `[context-manager] Injected ${observations.length} observations (${totalTokens} tokens) from ${projectCount} projects:`
      );
      lines.push(`  Projects: ${projectCounts}`);
      return lines.join("\n");
    }
  }
  lines.push(
    `[context-manager] Injected ${observations.length} observations (${totalTokens} tokens):`
  );
  const preview = observations.slice(0, 3);
  for (const obs of preview) {
    const timeAgo = calculateTimeAgo(obs.created_at);
    const firstFile = obs.files_touched[0];
    const fileInfo = firstFile ? ` (${firstFile})` : "";
    lines.push(`  - ${timeAgo}: ${obs.summary}${fileInfo}`);
  }
  if (observations.length > 3) {
    lines.push(`  ... and ${observations.length - 3} more`);
  }
  return lines.join("\n");
}

// src/utils/transcript.ts
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir as homedir3 } from "os";
function convertPathToDashed(projectPath) {
  return projectPath.replace(/\//g, "-");
}
function getTranscriptPath(project, sessionId) {
  const dashedPath = convertPathToDashed(project);
  return join(
    homedir3(),
    ".claude",
    "projects",
    dashedPath,
    `${sessionId}.jsonl`
  );
}
function extractTextFromContent(content) {
  if (!content)
    return null;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content.filter((block) => block.type === "text" && block.text).map((block) => block.text || "").filter((text) => text.length > 0);
    return textBlocks.length > 0 ? textBlocks.join("\n\n") : null;
  }
  return null;
}
function extractTextContent(entry) {
  if (entry.type === "assistant" && entry.message) {
    return extractTextFromContent(entry.message.content);
  }
  if (entry.role === "assistant") {
    return extractTextFromContent(entry.content);
  }
  return null;
}
function isAssistantEntry(entry) {
  if (entry.type === "assistant") {
    return true;
  }
  if (entry.role === "assistant") {
    return true;
  }
  return false;
}
function stripSystemReminderTags(text) {
  let result = "";
  let i = 0;
  const openTag = "<system-reminder>";
  const closeTag = "</system-reminder>";
  while (i < text.length) {
    const remainingLength = text.length - i;
    if (remainingLength >= openTag.length && text.substring(i, i + openTag.length) === openTag) {
      const closeIndex = text.indexOf(closeTag, i + openTag.length);
      if (closeIndex !== -1) {
        i = closeIndex + closeTag.length;
        continue;
      }
    }
    result += text[i];
    i++;
  }
  return result.trim();
}
function parseTranscriptForLastMessage(transcriptPath) {
  if (!existsSync(transcriptPath)) {
    return null;
  }
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line)
        continue;
      try {
        const entry = JSON.parse(line);
        if (isAssistantEntry(entry)) {
          const text = extractTextContent(entry);
          if (text && text.length > 0) {
            return stripSystemReminderTags(text);
          }
        }
      } catch (parseError) {
        continue;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}
async function getPreviouslyContext(project, currentSessionId, getRecentSessions) {
  const sessions = await getRecentSessions(project, 10);
  const priorSession = sessions.find(
    (s) => s.id !== currentSessionId && s.status === "complete"
  );
  if (!priorSession) {
    return null;
  }
  const transcriptPath = getTranscriptPath(project, priorSession.id);
  const lastMessage = parseTranscriptForLastMessage(transcriptPath);
  return lastMessage;
}

// plugin/hooks/context-inject.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
import { homedir as homedir4 } from "os";
var TOKEN_BUDGET = parseInt(
  process.env.CONTEXT_MANAGER_TOKEN_BUDGET || "4000",
  10
);
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
function checkVersionMismatch() {
  try {
    const installedPluginPath = join2(
      homedir4(),
      ".claude",
      "plugins",
      "context-manager",
      "package.json"
    );
    if (!existsSync2(installedPluginPath)) {
      return "";
    }
    const installedPackageJson = JSON.parse(
      readFileSync2(installedPluginPath, "utf-8")
    );
    const installedVersion = installedPackageJson.version;
    if (installedVersion !== "0.3.0") {
      return `
\u26A0\uFE0F  **context-manager version mismatch detected**
   Installed: v${installedVersion}
   Source:    v${"0.3.0"}
   Run: \`npm run build:plugin && /plugin install context-manager\`
`;
    }
    return "";
  } catch (error) {
    console.error("[context-manager] Version check failed:", error);
    return "";
  }
}
async function main() {
  console.error("[context-manager] SessionStart hook invoked");
  const storage = new SQLiteStorage();
  try {
    const inputStr = await readStdin();
    let rawInput;
    try {
      rawInput = inputStr.trim() ? JSON.parse(inputStr) : {};
    } catch (parseError) {
      console.error("[context-manager] Invalid JSON input, using defaults");
      rawInput = {};
    }
    const input = validateSessionStartInput(rawInput);
    await storage.initialize();
    await storage.createSession(input.session_id, input.cwd);
    const observations = await storage.getWithinBudget(input.cwd, TOKEN_BUDGET);
    const sessions = await storage.getRecentSessions(input.cwd, 1);
    const lastSummary = sessions[0]?.summary;
    const previouslyContext = await getPreviouslyContext(
      input.cwd,
      input.session_id,
      async (project, limit) => storage.getRecentSessions(project, limit)
    );
    const versionWarning = checkVersionMismatch();
    let context = buildContext(observations, input.cwd, lastSummary, previouslyContext);
    if (versionWarning) {
      context = versionWarning + "\n" + context;
    }
    const visibilityMessage = buildVisibilityMessage(observations, input.cwd);
    if (observations.length > 0) {
      console.error(visibilityMessage);
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context
      }
    }));
  } catch (error) {
    console.error("[context-manager] Error:", error);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: ""
      }
    }));
  } finally {
    storage.close();
  }
}
main();
