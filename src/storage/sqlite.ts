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
import { randomUUID } from 'crypto';
import path from 'path';
import { mkdirSync } from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { sha256, l2DistanceToCosine } from '../utils/hash.js';
import { detectFactType, FACT_CATEGORIES } from '../utils/facts.js';
import type {
  ContextStorage,
  Decision,
  Observation,
  ImportanceLevel,
  RelationshipType,
  SearchOptions,
  Session,
  Stats,
  UserPrompt,
  TimelineEntry,
  ProjectEntry,
  FileTouchEntry,
  TagTrendEntry,
  ProjectVelocityEntry,
} from './interface.js';

const DEFAULT_DB_PATH = path.join(homedir(), '.claude-context', 'context.db');

// Sentinel summary written by closeStaleActiveSessions() — used by getStats() to count GC-closed sessions.
// Kept as a shared constant so writer and reader cannot diverge silently across refactors.
const GC_SESSION_SUMMARY = '[Session ended abnormally - no Stop hook fired]';

/**
 * Compute a recency multiplier for temporal 'current' mode scoring.
 *
 * Observations written within the last 7 days score highest; observations
 * older than 90 days are deprioritized. The multiplier is applied to the
 * existing importance_score in-memory after SQL returns results.
 *
 * @param capturedAt - ISO 8601 timestamp from the observation's created_at field
 */
function recencyFactor(capturedAt: string): number {
  const ageMs = Date.now() - new Date(capturedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7)  return 1.5;
  if (ageDays <= 30) return 1.1;
  if (ageDays <= 90) return 0.9;
  return 0.7;
}

/**
 * Apply time-weighted decay to an observation's importance score at query time.
 *
 * Pinned observations (pinned = 1) are exempt — their base importance is returned
 * unchanged. All other observations receive a weighted combination of base importance,
 * exponential age decay (half-life ~23 days), and a log-scaled frequency bonus.
 *
 * Decay is transient — the adjusted score is for ranking only, never written to the DB.
 *
 * @param obs - The observation to score
 */
function applyDecay(obs: Observation): number {
  // Pinned observations use base importance only — no decay
  if (obs.pinned === 1) return obs.importance_score;

  const base = obs.importance_score;
  // created_at is non-null in schema; NULL from hand-imported data produces
  // near-zero recency score (graceful degradation, no throw).
  const ageMs = Date.now() - new Date(obs.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  // Recency score: exponential decay, half-life ~23 days
  // score = 0.5^(ageDays/23)
  const recencyScore = Math.pow(0.5, ageDays / 23);

  // Frequency score: log2(access_count + 1), normalized to [0, 1]
  // Cap at log2(101) for normalization ceiling
  const accessCount = obs.access_count ?? 0;
  const frequencyScore = Math.min(Math.log2(accessCount + 1) / Math.log2(101), 1.0);

  // Weighted combination
  return (base * 0.60) + (recencyScore * 0.25) + (frequencyScore * 0.15);
}

/**
 * Tokenize text for the token index.
 * Lowercases, splits on non-word characters, filters to length >= 4,
 * and deduplicates within the call.
 */
function extractTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const tok of text.toLowerCase().split(/\W+/)) {
    if (tok.length >= 4 && !seen.has(tok)) {
      seen.add(tok);
      tokens.push(tok);
    }
  }
  return tokens;
}

/**
 * Compute the Levenshtein edit distance between two strings.
 * Uses a standard DP matrix. Both strings are capped at 50 characters
 * to bound the maximum cost of the operation.
 */
function levenshtein(a: string, b: string): number {
  const s = a.length <= 50 ? a : a.substring(0, 50);
  const t = b.length <= 50 ? b : b.substring(0, 50);
  const m = s.length;
  const n = t.length;

  // Build two-row rolling DP to keep memory constant
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      // All indices are in-bounds by loop invariant; non-null assertions are safe.
      curr[j] = Math.min(
        prev[j]! + 1,         // deletion
        curr[j - 1]! + 1,     // insertion
        prev[j - 1]! + cost   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n]!;
}

export class SQLiteStorage implements ContextStorage {
  private db: Database.Database;
  private vecEnabled: boolean = false;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for concurrent access
    this.db.pragma('journal_mode = WAL');

    // Performance pragmas
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('cache_size = -64000');

    // CRITICAL P1 FIX: Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Load sqlite-vec extension for vector similarity search
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
    } catch {
      // sqlite-vec not available — graceful degradation
      this.vecEnabled = false;
    }
  }

  /** Exposed only for admin/migration tooling. Do not use in normal storage paths. */
  get rawDb(): Database.Database {
    return this.db;
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

    // Migration: add exported_at column
    this.migrateAddExportedAtColumn();

    // Migration: add vector search support
    this.migrateAddVectorSearch();

    // Migration: add session-level vector search
    this.migrateAddSessionVectorSearch();

    // Migration: add file encounter counts for surprise scoring
    this.migrateAddFileEncounterCounts();

    // Migration: add observation relationships
    this.migrateAddObservationRelationships();

    // Migration: add domain tags column
    this.migrateAddTagsColumn();

    // Migration: add content_hash column for exact dedup
    this.migrateAddContentHash();

    // Migration: add summary_extended column for multi-beat session narratives
    this.migrateAddSummaryExtended();

    // Migration: add last_checkpoint_at column for periodic checkpoint tracking
    this.migrateAddLastCheckpointAt();

    // Migration: add source column to sessions for manual vs hook sessions
    this.migrateAddSessionSource();

    // Migration: convert comma-separated tags to JSON array format for json_each compatibility
    this.migrateTagsToJson();

    // Migration: add lesson_type column for error lesson classification
    this.migrateAddLessonType();

    // Migration: add decisions table for first-class decision tracking
    this.migrateAddDecisionsTable();

    // Migration: add pinned and access_count columns for decay-exempt observations and retrieval frequency
    this.migrateAddPinnedAndAccessCount();

    // Migration: add meta table for lightweight key-value persistence (e.g. last reflection date)
    this.migrateAddMetaTable();

    // Migration: add branch column to observations and sessions for git branch-aware capture
    this.migrateAddBranchColumn();

    // Migration: add superseded_by column for fact supersession detection
    this.migrateAddSupersededBy();

    // Migration: add token_index table for fuzzy search correction
    this.migrateAddTokenIndex();
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
   * Add exported_at column if it doesn't exist.
   */
  private migrateAddExportedAtColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('exported_at')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN exported_at TEXT`);
    }
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
      exported_at: (row.exported_at as string) || undefined,
      tags: row.tags ? (
        (row.tags as string).startsWith('[')
          ? (JSON.parse(row.tags as string) as string[])
          : (row.tags as string).split(',').filter(Boolean)
      ) : undefined,
      content_hash: (row.content_hash as string) || undefined,
      lesson_type: (row.lesson_type as string | null) ?? null,
      pinned: (row.pinned as number) ?? 0,
      access_count: (row.access_count as number) ?? 0,
      branch: (row.branch as string | null) ?? null,
      superseded_by: row.superseded_by != null ? (row.superseded_by as number) : null,
      created_at: row.created_at as string,
    };
  }

  async save(observation: Omit<Observation, 'id'>): Promise<number | undefined> {
    // --- Layer 1: Exact SHA256 dedup (same project, no time window) ---
    // Hash covers summary + files_touched + stored_output so that same-content
    // tool results are detected even when called at different times.
    const storedOutput =
      typeof (observation.metadata as Record<string, unknown>)?.stored_output === 'string'
        ? ((observation.metadata as Record<string, unknown>).stored_output as string)
        : '';
    const hashInput = `${observation.summary}\n${JSON.stringify(observation.files_touched)}\n${storedOutput}`;
    const contentHash = sha256(hashInput);

    const hashCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM observations
      WHERE project LIKE ? AND content_hash = ?
    `).get(observation.project + '%', contentHash) as { count: number };

    if (hashCheck.count > 0) {
      return undefined;
    }

    // --- Layer 0: Time-windowed prefix dedup (existing logic) ---
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
      return undefined;
    }

    const stmt = this.db.prepare(`
      INSERT INTO observations (
        session_id, project, package, tool_name, summary,
        files_touched, metadata, token_estimate,
        importance, importance_score, tags, content_hash, lesson_type, branch, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tagsValue = observation.tags && observation.tags.length > 0
      ? JSON.stringify(observation.tags)
      : null;

    const info = stmt.run(
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
      tagsValue,
      contentHash,
      observation.lesson_type ?? null,
      observation.branch ?? null,
      observation.created_at
    );

    const insertedId = Number(info.lastInsertRowid);

    // Infer relationships for the newly inserted observation
    this.inferRelationships(insertedId, observation);

    // Auto-pin observations tagged 'decision' or 'lesson', or with a lesson_type.
    // Tags are stored as JSON arrays (e.g., ["decision","auth"]).
    // Using JSON string matching covers both tagged and lesson-classified observations.
    this.db.prepare(`
      UPDATE observations SET pinned = 1
      WHERE id = ?
        AND (
          tags LIKE '%"decision"%' OR tags LIKE '%"lesson"%'
          OR lesson_type IS NOT NULL
        )
    `).run(insertedId);

    // Check for superseded facts (stack preference detection). Wrapped in
    // try/catch so a detection failure does not abort the save.
    try {
      const fact = detectFactType(observation.summary ?? '');
      if (fact) {
        const cat = FACT_CATEGORIES.find(c => c.name === fact.category);
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
      // Fact detection is best-effort. The observation was already saved.
    }

    // Index tokens from the summary for fuzzy search correction.
    // Best-effort: a failure here must never abort the save.
    try {
      const tokens = extractTokens(observation.summary);
      if (tokens.length > 0) {
        this.addTokens(tokens);
      }
    } catch {
      // Token indexing is non-critical.
    }

    return insertedId;
  }

  async getRecent(project: string, limit: number = 50, offset: number = 0, toolName?: string): Promise<Observation[]> {
    // Use LIKE for prefix matching (parent directory sees children).
    // Tool filter pushed into SQL so paginated results are dense (fixes #127).
    const toolClause = toolName ? ' AND tool_name = ?' : '';
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?${toolClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);

    const params: unknown[] = [project + '%'];
    if (toolName) params.push(toolName);
    params.push(limit, offset);

    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async getWithinBudget(
    project: string,
    tokenBudget: number
  ): Promise<Observation[]> {
    const effectiveBudget = Math.floor(tokenBudget * 0.8);
    const HIGH_IMPORTANCE_ALLOCATION = 0.6;

    // Use LIKE for prefix matching (parent directory sees children).
    // LIMIT 500 caps memory usage on mature databases.
    // Exclude compacted observations and superseded facts from budget calculation.
    const stmt = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ?
        AND is_compacted = 0
        AND superseded_by IS NULL
      ORDER BY importance_score DESC, created_at DESC
      LIMIT 500
    `);

    const rows = stmt.all(project + '%') as Array<Record<string, unknown>>;

    // Apply decay transiently for ranking — consistent with search() behavior.
    // The adjusted score is never written to the DB.
    const scoredRows = rows.map(row => {
      const obs = this.mapRow(row);
      return { obs, score: applyDecay(obs) };
    });
    scoredRows.sort((a, b) => b.score - a.score);

    // Pass 1: fill up to 60% of budget from high-importance observations (score >= 0.65)
    const highBudget = Math.floor(HIGH_IMPORTANCE_ALLOCATION * effectiveBudget);
    const highResults: Observation[] = [];
    const includedIds = new Set<number>();
    let highTokens = 0;

    for (const { obs } of scoredRows) {
      if (obs.importance_score < 0.65) continue;
      if (highTokens + obs.token_estimate > highBudget) continue;
      highResults.push(obs);
      if (obs.id !== undefined) includedIds.add(obs.id);
      highTokens += obs.token_estimate;
    }

    // Pass 2: fill remaining budget from everything else (sorted by decayed score)
    const remainingBudget = effectiveBudget - highTokens;
    const lowResults: Observation[] = [];
    let lowTokens = 0;

    for (const { obs } of scoredRows) {
      if (obs.id !== undefined && includedIds.has(obs.id)) continue;
      if (lowTokens + obs.token_estimate > remainingBudget) continue;
      lowResults.push(obs);
      lowTokens += obs.token_estimate;
    }

    return [...highResults, ...lowResults];
  }

  async search(query: string, projectOrOptions?: string | SearchOptions): Promise<Observation[]> {
    // Normalize overloaded argument: accept legacy string or SearchOptions object
    const project = typeof projectOrOptions === 'string'
      ? projectOrOptions
      : projectOrOptions?.project;
    const temporalMode = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? (projectOrOptions.temporalMode ?? 'neutral')
      : 'neutral';
    const skipDecay = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? (projectOrOptions.skipDecay ?? false)
      : false;
    // branch: exact match filter when set and not '*'; '*' means no filter; undefined means no SQL filter
    const branchFilter = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? projectOrOptions.branch
      : undefined;
    // include_superseded: when false (default), exclude observations with a non-null superseded_by
    const includeSuperseded = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? (projectOrOptions.include_superseded ?? false)
      : false;
    // offset: pagination offset; only used when search() is called with SearchOptions
    const searchOffset = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? (projectOrOptions.offset ?? 0)
      : 0;
    // importance: exact match filter when provided (refs #131)
    const importance = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? projectOrOptions.importance
      : undefined;
    // toolName: exact match filter pushed into SQL for dense pagination (fixes #127)
    const toolName = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? projectOrOptions.toolName
      : undefined;

    let sql: string;
    let params: unknown[];

    // Escape FTS5 special characters by wrapping each token in double quotes.
    // This prevents dots, hyphens, and other chars from being parsed as FTS5 operators.
    const ftsQuery = query.replace(/"/g, '""')  // escape existing double quotes
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => `"${t}"`)
      .join(' ');

    // Exact branch filter clause (only when branchFilter is defined and not '*')
    const hasBranchFilter = branchFilter !== undefined && branchFilter !== '*';
    // Superseded exclusion clause added to all search paths when include_superseded is false
    const supersededClause = includeSuperseded ? '' : ' AND o.superseded_by IS NULL';
    // Importance filter clause (refs #131)
    const importanceClause = importance ? ' AND o.importance = ?' : '';
    // Tool name filter clause (fixes #127)
    const toolClause = toolName ? ' AND o.tool_name = ?' : '';
    // Limit and offset for FTS queries (searchOffset only non-zero when called via web API)
    const limitParam = typeof projectOrOptions === 'object' && projectOrOptions !== null
      ? (projectOrOptions.limit ?? 50)
      : 50;
    const paginationClause = searchOffset > 0 ? `LIMIT ${limitParam} OFFSET ${searchOffset}` : `LIMIT ${limitParam}`;

    if (project && hasBranchFilter) {
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ? AND o.branch = ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery, project + '%', branchFilter];
      if (importance) params.push(importance);
      if (toolName) params.push(toolName);
    } else if (project) {
      // Use LIKE for prefix matching (parent directory sees children)
      // FTS5 requires full table name in MATCH clause (aliases don't work)
      sql = `
        SELECT o.* FROM observations o
        INNER JOIN observations_fts ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project LIKE ?${importanceClause}${toolClause}${supersededClause}
        ORDER BY o.created_at DESC
        ${paginationClause}
      `;
      params = [ftsQuery, project + '%'];
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
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;
    let results = rows.map(row => this.mapRow(row));

    // Increment access_count for all returned observations (synchronous better-sqlite3 call).
    // The DB is written here so that future searches see the updated frequency.
    // In-memory objects are NOT updated: applyDecay() below uses the pre-retrieval
    // access_count so this search does not boost its own decay score. The incremented
    // value takes effect on the next retrieval — "observations retrieved often stay
    // relevant" refers to past retrievals, not the current one.
    // The guard on ids.length > 0 prevents an empty IN () clause which would be a SQL error.
    if (results.length > 0) {
      const ids = results.map(o => o.id).filter((id): id is number => id != null);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        this.db.prepare(
          `UPDATE observations SET access_count = access_count + 1 WHERE id IN (${placeholders})`
        ).run(...ids);
      }
    }

    // Apply temporal mode post-query adjustments
    if (temporalMode === 'current') {
      // Returns transient scoring copies -- importance_score reflects recency adjustment
      // for display only and is not written back to the database.
      // Multiply each result's base score by a recency factor, then re-sort descending
      return results
        .map(obs => ({
          ...obs,
          importance_score: (obs.importance_score ?? 0.5) * recencyFactor(obs.created_at),
        }))
        .sort((a, b) => b.importance_score - a.importance_score);
    }

    if (temporalMode === 'historical') {
      // Sort chronologically ascending (oldest first); no score changes
      return results.sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
    }

    // neutral: apply decay only when no temporal override is active and skipDecay is false.
    // Temporal mode ('current' / 'historical') already controls ranking — stacking decay
    // on top would double-penalize age and produce conflicting signals.
    // Decay is transient — adjusted importance_score is for ranking only, not written back to DB.
    if (!skipDecay) {
      results = results.map(obs => ({
        ...obs,
        importance_score: applyDecay(obs),
      }));
      results.sort((a, b) => b.importance_score - a.importance_score);
    }

    return results;
  }

  async searchByTag(tag: string, project?: string, limit: number = 50, includeSuperseded: boolean = false): Promise<Observation[]> {
    // Tags are stored as JSON arrays (e.g. ["auth","database"]).
    // Use json_each() for exact value matching, the same pattern used in getTagTrend().
    // Superseded exclusion clause applied by default
    const supersededClause = includeSuperseded ? '' : ' AND o.superseded_by IS NULL';
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = `
        SELECT o.* FROM observations o
        WHERE o.tags IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(o.tags) WHERE json_each.value = ?)
          AND o.project LIKE ?${supersededClause}
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [tag, project + '%', limit];
    } else {
      sql = `
        SELECT o.* FROM observations o
        WHERE o.tags IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(o.tags) WHERE json_each.value = ?)${supersededClause}
        ORDER BY o.created_at DESC
        LIMIT ?
      `;
      params = [tag, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async getStats(project?: string): Promise<Stats> {
    const parsed = parseInt(process.env.CONTEXT_MANAGER_TOKEN_BUDGET || '4000', 10);
    const TOKEN_BUDGET = Number.isFinite(parsed) && parsed > 0 && parsed <= 100000 ? parsed : 4000;

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

    // Budget fill: call getWithinBudget to get the actual tiered-allocation result.
    // Fetches up to 500 rows and applies decay in-process — acceptable since context_stats
    // is called infrequently (on-demand via MCP tool or CLI, not on a hot path).
    const budgetObs = await this.getWithinBudget(project ?? '', TOKEN_BUDGET);
    const budgetFillTokens = budgetObs.reduce((sum, o) => sum + o.token_estimate, 0);

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

    // Wrap json_extract in datetime() to canonicalize the ISO-8601 stored value
    // ('2026-05-26T14:30:00.000Z') to SQLite's internal format before comparison.
    // Without this, the 'T' separator (ASCII 84) sorts above space (ASCII 32),
    // making every stored timestamp compare as "more recent" than datetime() output.
    const compactedLast24hSql = project
      ? `SELECT COUNT(*) as count FROM observations WHERE is_compacted = 1 AND datetime(json_extract(metadata, '$.compacted_at')) > datetime('now', '-1 day') AND project LIKE ? || '%'`
      : `SELECT COUNT(*) as count FROM observations WHERE is_compacted = 1 AND datetime(json_extract(metadata, '$.compacted_at')) > datetime('now', '-1 day')`;
    const compactedLast24hRow = this.db.prepare(compactedLast24hSql).get(
      ...(project ? [project] : [])
    ) as { count: number } | undefined;

    const gcLast24hSql = project
      ? `SELECT COUNT(*) as count FROM sessions WHERE summary = ? AND ended_at > datetime('now', '-1 day') AND project LIKE ? || '%'`
      : `SELECT COUNT(*) as count FROM sessions WHERE summary = ? AND ended_at > datetime('now', '-1 day')`;
    const gcLast24hRow = this.db.prepare(gcLast24hSql).get(
      ...(project ? [GC_SESSION_SUMMARY, project] : [GC_SESSION_SUMMARY])
    ) as { count: number } | undefined;

    const eligibleSql = project
      ? `SELECT COALESCE(SUM(cnt), 0) as count FROM (SELECT COUNT(*) as cnt FROM observations WHERE created_at < datetime('now', '-7 days') AND importance != 'high' AND is_compacted = 0 AND project LIKE ? || '%' GROUP BY session_id, tool_name HAVING COUNT(*) >= 3)`
      : `SELECT COALESCE(SUM(cnt), 0) as count FROM (SELECT COUNT(*) as cnt FROM observations WHERE created_at < datetime('now', '-7 days') AND importance != 'high' AND is_compacted = 0 GROUP BY session_id, tool_name HAVING COUNT(*) >= 3)`;
    const eligibleRow = this.db.prepare(eligibleSql).get(
      ...(project ? [project] : [])
    ) as { count: number } | undefined;

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
      next_compaction_eligible: eligibleRow?.count || 0,
    };
  }

  async createSession(sessionId: string, project: string, branch?: string | null): Promise<void> {
    // Upsert: insert new session or update the project path if the session already
    // exists. The project update handles context-window overflow: Claude Code reuses
    // the same session_id when resuming a conversation after compaction, but the
    // working directory may differ from the original session. Updating project here
    // keeps the sessions table aligned with where observations are actually captured.
    // All other columns (status, started_at, summary) are left unchanged so the
    // session's history is preserved.
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, project, started_at, status, branch)
      VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET project = excluded.project
    `);

    stmt.run(sessionId, project, new Date().toISOString(), branch ?? null);
  }

  async endSession(sessionId: string, summary?: string, summaryExtended?: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = ?, summary_extended = ?, status = 'complete'
      WHERE id = ?
    `);

    stmt.run(new Date().toISOString(), summary || null, summaryExtended || null, sessionId);
  }

  async updateSessionDraftSummary(sessionId: string, summary: string): Promise<void> {
    if (!summary) return;
    // Only update summary. Leave status, ended_at, and all other fields intact.
    // The Stop hook will overwrite summary with the final version on clean exit.
    this.db.prepare(`
      UPDATE sessions SET summary = ? WHERE id = ?
    `).run(summary, sessionId);
  }

  async updateSessionCheckpoint(sessionId: string, timestamp: number): Promise<void> {
    this.db.prepare(`
      UPDATE sessions SET last_checkpoint_at = ? WHERE id = ?
    `).run(timestamp, sessionId);
  }

  async getSessionTimestamps(
    sessionId: string
  ): Promise<{ started_at: string; last_checkpoint_at: number | null } | null> {
    const row = this.db.prepare(`
      SELECT started_at, last_checkpoint_at FROM sessions WHERE id = ?
    `).get(sessionId) as { started_at: string; last_checkpoint_at: number | null } | undefined;

    return row ?? null;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const row = this.db.prepare(`
      SELECT id, project, started_at, ended_at, summary, summary_extended,
             source, status, last_checkpoint_at, branch
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `).get(id) as {
      id: string;
      project: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      summary_extended: string | null;
      source: string | null;
      status: 'active' | 'complete';
      last_checkpoint_at: number | null;
      branch: string | null;
    } | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || undefined,
      summary: row.summary || undefined,
      summary_extended: row.summary_extended || undefined,
      source: row.source || undefined,
      status: row.status,
      last_checkpoint_at: row.last_checkpoint_at ?? undefined,
      branch: row.branch ?? null,
    };
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
      summary_extended: string | null;
      status: 'active' | 'complete';
      branch: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || undefined,
      summary: row.summary || undefined,
      summary_extended: row.summary_extended || undefined,
      status: row.status,
      branch: row.branch ?? null,
    }));
  }

  async getDistinctBranches(project: string): Promise<string[]> {
    // refs #131: return distinct non-null branch names for sessions in this project
    const rows = this.db.prepare(`
      SELECT DISTINCT branch FROM sessions
      WHERE project LIKE ? || '%' AND branch IS NOT NULL AND branch != ''
      ORDER BY branch ASC
    `).all(project) as Array<{ branch: string }>;
    return rows.map(r => r.branch);
  }

  async getRecentSessionsWithCounts(
    project: string,
    limit: number,
    offset: number,
    status?: string,
    branch?: string
  ): Promise<Array<Session & { observation_count: number; total_tokens: number }>> {
    // Single query that joins sessions with aggregated observation stats.
    // Eliminates the N+1 pattern of loading each session's observations separately.
    // refs #131: added optional branch filter
    const statusClause = status ? 'AND s.status = ?' : '';
    const branchClause = branch ? 'AND s.branch = ?' : '';
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

    const params: unknown[] = [project];
    if (status) params.push(status);
    if (branch) params.push(branch);
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      project: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      summary_extended: string | null;
      status: 'active' | 'complete';
      branch: string | null;
      observation_count: number;
      total_tokens: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || undefined,
      summary: row.summary || undefined,
      summary_extended: row.summary_extended || undefined,
      status: row.status,
      branch: row.branch ?? null,
      observation_count: row.observation_count,
      total_tokens: row.total_tokens,
    }));
  }

  async closeStaleActiveSessions(staleSessionHours = 2): Promise<number> {
    // Pre-compute ISO threshold to avoid SQL string concatenation (which would
    // defeat parameterization and open a SQL injection vector).
    const staleThresholdMs = Date.now() - staleSessionHours * 60 * 60 * 1000;
    const staleThresholdISO = new Date(staleThresholdMs).toISOString();

    const staleResult = this.db.prepare(`
      UPDATE sessions
      SET
        status = 'complete',
        ended_at = datetime('now'),
        summary = ?
      WHERE status = 'active'
        AND ended_at IS NULL
        AND (
          (last_checkpoint_at IS NOT NULL
            AND datetime(last_checkpoint_at / 1000, 'unixepoch') < ?)
          OR
          (last_checkpoint_at IS NULL
            AND started_at < ?)
        )
    `).run(GC_SESSION_SUMMARY, staleThresholdISO, staleThresholdISO);

    return staleResult.changes;
  }

  async vacuum(olderThanDays?: number, staleSessionHours = 2, include_high = false): Promise<{
    observations: number;
    sessions: number;
    compacted: number;
    compacted_originals: number;
    closedStaleSessions: number;
  }> {
    let deletedObservations = 0;

    // Close stale active sessions before orphan cleanup so the now-complete sessions
    // are not caught by the orphan check that follows.
    const closedStaleSessions = await this.closeStaleActiveSessions(staleSessionHours);

    if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
      const cutoffISO = cutoffDate.toISOString();

      // By default, protect high-importance, pinned, and lesson observations from deletion.
      // Pass include_high=true to override and delete all matching observations.
      const guardClause = include_high
        ? ''
        : ' AND importance_score < 0.65 AND pinned = 0 AND lesson_type IS NULL';

      const stmt = this.db.prepare(`
        DELETE FROM observations
        WHERE created_at < ?${guardClause}
      `);

      const result = stmt.run(cutoffISO);
      deletedObservations = result.changes;
    }

    // Clean up orphaned observations BEFORE compaction (referencing non-existent sessions)
    // Compaction groups by session_id and inserts new rows — if orphaned observations
    // reference deleted sessions, the INSERT will violate the FK constraint.
    this.db.prepare(`
      DELETE FROM observations
      WHERE session_id NOT IN (SELECT id FROM sessions)
    `).run();

    // Run compaction on observations older than 7 days
    const compactionResult = await this.compactObservations(7);

    // Clean up ghost sessions: never closed, 0 observations, older than 24h.
    // These accumulate when a conversation starts but Claude Code is closed before
    // any tool calls are made (Stop hook never fires, session stays open forever).
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

    // Clean up orphaned user_prompts (sessions with no remaining observations)
    this.db.prepare(`
      DELETE FROM user_prompts
      WHERE session_id NOT IN (SELECT DISTINCT session_id FROM observations)
    `).run();

    // Clean up orphaned sessions (no observations AND no prompts)
    const orphanStmt = this.db.prepare(`
      DELETE FROM sessions
      WHERE id NOT IN (SELECT DISTINCT session_id FROM observations)
        AND id NOT IN (SELECT DISTINCT session_id FROM user_prompts)
    `);
    const orphanResult = orphanStmt.run();
    const deletedSessions = orphanResult.changes + deletedGhostSessions;

    // Update query planner statistics and reclaim space
    // Temporarily disable FK checks for VACUUM (pre-existing violations may remain)
    this.db.pragma('foreign_keys = OFF');
    this.db.exec('ANALYZE');
    this.db.exec('VACUUM');
    this.db.pragma('foreign_keys = ON');

    return {
      observations: deletedObservations,
      sessions: deletedSessions,
      compacted: compactionResult.compacted,
      compacted_originals: compactionResult.originals,
      closedStaleSessions,
    };
  }

  async prune(options: {
    toolName?: string;
    importance?: ImportanceLevel;
    olderThanDays?: number;
    dryRun?: boolean;
    include_high?: boolean;
  }): Promise<{ deleted: number; preview?: string[] }> {
    const { toolName, importance, olderThanDays, dryRun = false, include_high = false } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // By default, protect high-importance, pinned, and lesson observations.
    // These guards are prepended so they apply to all four SQL paths (dry-run
    // COUNT, dry-run preview SELECT, ID collection SELECT, and final DELETE)
    // via the shared `where` string built below.
    if (!include_high) {
      conditions.push('importance_score < 0.65');
      conditions.push('pinned = 0');
      conditions.push('lesson_type IS NULL');
    }

    if (olderThanDays !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      conditions.push('created_at < ?');
      params.push(cutoff.toISOString());
    }
    if (toolName) {
      conditions.push('tool_name = ?');
      params.push(toolName);
    }
    if (importance) {
      conditions.push('importance = ?');
      params.push(importance);
    }

    // Require at least one user-supplied filter — prevent accidental full wipe.
    // The high-importance guard conditions do not count toward this requirement.
    const userFilterCount = (olderThanDays !== undefined ? 1 : 0) + (toolName ? 1 : 0) + (importance ? 1 : 0);
    if (userFilterCount === 0) {
      return { deleted: 0 };
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    if (dryRun) {
      const total = (
        this.db.prepare(`SELECT COUNT(*) as cnt FROM observations ${where}`).get(...params) as {
          cnt: number;
        }
      ).cnt;
      const rows = this.db
        .prepare(
          `SELECT tool_name, importance, summary FROM observations ${where} ORDER BY created_at DESC LIMIT 5`
        )
        .all(...params) as Array<{ tool_name: string; importance: string; summary: string }>;
      const preview = rows.map(r => `[${r.importance}] ${r.tool_name}: ${r.summary.slice(0, 80)}`);
      return { deleted: total, preview };
    }

    // Collect IDs first so we can clean up vec_observations (vec0 does not cascade)
    const ids = (
      this.db
        .prepare(`SELECT id FROM observations ${where}`)
        .all(...params) as Array<{ id: number }>
    ).map(r => r.id);

    if (ids.length === 0) {
      return { deleted: 0 };
    }

    if (this.vecEnabled) {
      const idJson = JSON.stringify(ids);
      this.db
        .prepare(
          `DELETE FROM vec_observations WHERE observation_id IN (SELECT value FROM json_each(?))`
        )
        .run(idJson);
    }

    const result = this.db.prepare(`DELETE FROM observations ${where}`).run(...params);
    return { deleted: result.changes };
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

    // Index tokens from the prompt for fuzzy search correction.
    // Best-effort: a failure here must never abort the save.
    try {
      const tokens = extractTokens(prompt.prompt_text);
      if (tokens.length > 0) {
        this.addTokens(tokens);
      }
    } catch {
      // Token indexing is non-critical.
    }
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

    // Escape FTS5 special characters (same as search())
    const ftsQuery = query.replace(/"/g, '""')
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => `"${t}"`)
      .join(' ');

    if (project) {
      // FTS5 requires full table name in MATCH clause (aliases don't work)
      sql = `
        SELECT p.* FROM user_prompts p
        INNER JOIN user_prompts_fts ON p.id = user_prompts_fts.rowid
        WHERE user_prompts_fts MATCH ? AND p.project LIKE ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `;
      params = [ftsQuery, project + '%'];
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

  async getFileTouchFrequency(project?: string, days: number = 30, limit: number = 10): Promise<FileTouchEntry[]> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffISO = cutoff.toISOString();

    // json_each expands the JSON array in files_touched into individual rows.
    // Explicit JOIN form is unambiguous and avoids implicit cross join order dependency.
    const base = `
      SELECT j.value AS file_path, COUNT(*) AS touch_count
      FROM observations
      JOIN json_each(observations.files_touched) AS j
        ON observations.files_touched IS NOT NULL
        AND observations.files_touched != '[]'
      WHERE observations.created_at >= ?
    `;

    let sql: string;
    let params: unknown[];

    if (project) {
      sql = base + ` AND observations.project LIKE ?
        GROUP BY file_path ORDER BY touch_count DESC LIMIT ?`;
      params = [cutoffISO, project + '%', limit];
    } else {
      sql = base + `
        GROUP BY file_path ORDER BY touch_count DESC LIMIT ?`;
      params = [cutoffISO, limit];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ file_path: string; touch_count: number }>;
    return rows;
  }

  async getTagTrend(project?: string, weeks: number = 12): Promise<TagTrendEntry[]> {
    const cutoff = new Date();
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

    let sql: string;
    let params: unknown[];

    if (project) {
      sql = base + ` AND observations.project LIKE ?
        GROUP BY week, tag ORDER BY week ASC, count DESC
        LIMIT 500`;
      params = [cutoffISO, project + '%'];
    } else {
      sql = base + `
        GROUP BY week, tag ORDER BY week ASC, count DESC
        LIMIT 500`;
      params = [cutoffISO];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{ week: string; tag: string; count: number }>;
    return rows;
  }

  async getProjectVelocity(project?: string, weeks: number = 12): Promise<ProjectVelocityEntry[]> {
    const cutoff = new Date();
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

    let sql: string;
    let params: unknown[];

    if (project) {
      sql = base + ` AND project LIKE ?
        GROUP BY week, project ORDER BY week ASC, observations DESC`;
      params = [cutoffISO, project + '%'];
    } else {
      sql = base + `
        GROUP BY week, project ORDER BY week ASC, observations DESC`;
      params = [cutoffISO];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      week: string;
      project: string;
      sessions: number;
      observations: number;
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
        AND is_compacted = 0
        AND superseded_by IS NULL
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

  async countObservations(project?: string, tool?: string, importance?: ImportanceLevel): Promise<number> {
    // refs #131: added optional importance parameter
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (project) {
      conditions.push('project LIKE ?');
      params.push(project + '%');
    }
    if (tool) {
      conditions.push('tool_name = ?');
      params.push(tool);
    }
    if (importance) {
      conditions.push('importance = ?');
      params.push(importance);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM observations ${where}`;

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  async countSessions(project?: string, status?: string, branch?: string): Promise<number> {
    // refs #131: added optional branch parameter
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (project) {
      conditions.push('project LIKE ?');
      params.push(project + '%');
    }
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (branch) {
      conditions.push('branch = ?');
      params.push(branch);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM sessions ${where}`;

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
    // Never compact high-importance or already-compacted observations.
    // all_files is intentionally omitted here — GROUP_CONCAT(REPLACE(...)) corrupts
    // JSON arrays that contain commas (all file paths), causing the catch block to
    // discard all file data. Files are fetched per-group below instead.
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
    `).all(cutoffISO) as Array<{
      session_id: string;
      tool_name: string;
      cnt: number;
      ids: string;
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

    // vec_observations is a vec0 virtual table with no FK cascade — must be
    // cleaned up manually, just like the prune() method does.
    const deleteVec = this.vecEnabled
      ? this.db.prepare(
          `DELETE FROM vec_observations WHERE observation_id IN (SELECT value FROM json_each(?))`
        )
      : null;

    // Fetch files_touched for a group of observation IDs in one query.
    // Prepared once outside the transaction loop for efficiency.
    const fetchFilesStmt = this.db.prepare(
      `SELECT files_touched FROM observations WHERE id IN (SELECT value FROM json_each(?))`
    );

    const compact = this.db.transaction(() => {
      for (const group of groups) {
        // Parse the id list once — reused for file fetch, vec delete, and originals delete.
        const idList = group.ids.split(',').map(Number);

        // Fetch and flatten files_touched for all observations in this group.
        // Using a separate SELECT per group avoids GROUP_CONCAT corruption: any file path
        // containing a comma (e.g. "/a,b/file.ts") would break the GROUP_CONCAT approach.
        const fileRows = fetchFilesStmt.all(JSON.stringify(idList)) as Array<{ files_touched: string }>;
        const fileEntries = fileRows.flatMap(row => {
          try { return JSON.parse(row.files_touched || '[]') as string[]; }
          catch { return []; }
        }).filter(f => f && f.length > 0);
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
          JSON.stringify({ compacted_from: group.cnt, original_tokens: group.total_tokens, compacted_at: new Date().toISOString() }),
          tokenEstimate,
          group.earliest
        );

        // Delete originals and their vector rows (compacted replacement inserted above)
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

  async getUnexportedHighImportance(
    project: string,
    sessionId?: string,
    minScore: number = 0.65
  ): Promise<Observation[]> {
    let sql: string;
    let params: unknown[];

    if (sessionId) {
      sql = `
        SELECT * FROM observations
        WHERE project LIKE ? AND session_id = ?
          AND importance_score >= ? AND exported_at IS NULL
        ORDER BY created_at ASC
      `;
      params = [project + '%', sessionId, minScore];
    } else {
      sql = `
        SELECT * FROM observations
        WHERE project LIKE ?
          AND importance_score >= ? AND exported_at IS NULL
        ORDER BY created_at ASC
      `;
      params = [project + '%', minScore];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  async markExported(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE observations SET exported_at = ? WHERE id IN (SELECT value FROM json_each(?))`
    );
    stmt.run(now, JSON.stringify(ids));
  }

  /**
   * Migration: add embedding column and vec0 virtual table for vector search.
   * Only creates the vec0 table if sqlite-vec loaded successfully.
   */
  private migrateAddVectorSearch(): void {
    // Add embedding BLOB column if it doesn't exist
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('embedding')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN embedding BLOB`);
    }

    if (!this.vecEnabled) return;

    // Create vec0 virtual table for 384-dimensional float vectors
    // vec0 tables use CREATE VIRTUAL TABLE which is idempotent-safe
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(
          observation_id INTEGER PRIMARY KEY,
          embedding float[384]
        )
      `);
    } catch {
      // vec0 table creation failed — disable vector search
      this.vecEnabled = false;
    }
  }

  isVectorSearchEnabled(): Promise<boolean> {
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
  private checkSemanticDuplicate(
    embedding: Float32Array,
    project: string,
    id: number,
    threshold: number = 0.85
  ): boolean {
    if (!this.vecEnabled) return false;

    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Fetch the nearest neighbor from vec_observations, scoped to same project,
    // excluding the observation itself (it may already have an old embedding).
    // k=10 gives a pool large enough to cover same-project results after the
    // JOIN + exclusion filter. k=1 would only return the global nearest neighbor,
    // which may be from a different project and get filtered out entirely.
    const row = this.db.prepare(`
      SELECT v.distance
      FROM vec_observations v
      INNER JOIN observations o ON o.id = v.observation_id
      WHERE v.embedding MATCH ? AND k = ?
        AND o.project LIKE ?
        AND v.observation_id != CAST(? AS INTEGER)
      ORDER BY v.distance ASC
      LIMIT 1
    `).get(embeddingBuf, 10, project + '%', id) as { distance: number } | undefined;

    if (!row) return false;
    return l2DistanceToCosine(row.distance) >= threshold;
  }

  async saveEmbedding(id: number, embedding: Float32Array): Promise<void> {
    if (!this.vecEnabled) {
      throw new Error('Vector search is not enabled (sqlite-vec not loaded)');
    }

    // Layer 2: semantic dedup — demote near-duplicates before indexing.
    // Runs here rather than in save() because the embedding model isn't loaded
    // in the hook process (would add >100ms latency per capture).
    const obs = this.db.prepare(
      `SELECT project FROM observations WHERE id = ?`
    ).get(id) as { project: string } | undefined;

    if (obs && this.checkSemanticDuplicate(embedding, obs.project, id)) {
      this.db.prepare(
        `UPDATE observations SET importance = 'low', importance_score = 0.05 WHERE id = ?`
      ).run(id);
    }

    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const saveTransaction = this.db.transaction(() => {
      // Save embedding blob on the observations row
      this.db.prepare(
        `UPDATE observations SET embedding = ? WHERE id = ?`
      ).run(embeddingBuf, id);

      // Upsert into vec0 index — CAST required because vec0 only accepts
      // SQL INTEGER types for primary keys, not JS numbers via parameters
      this.db.prepare(
        `INSERT OR REPLACE INTO vec_observations (observation_id, embedding) VALUES (CAST(? AS INTEGER), ?)`
      ).run(id, embeddingBuf);
    });

    saveTransaction();
  }

  async vectorSearch(embedding: Float32Array, project?: string, topK: number = 10): Promise<Observation[]> {
    if (!this.vecEnabled) {
      throw new Error('Vector search is not enabled (sqlite-vec not loaded)');
    }

    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    let sql: string;
    let params: unknown[];

    if (project) {
      sql = `
        SELECT o.*, v.distance
        FROM vec_observations v
        INNER JOIN observations o ON o.id = v.observation_id
        WHERE v.embedding MATCH ? AND k = ?
          AND o.project LIKE ?
        ORDER BY v.distance ASC
      `;
      params = [embeddingBuf, topK, project + '%'];
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

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => {
      const obs = this.mapRow(row);
      const distance = row.distance as number | undefined;
      if (distance != null) {
        obs.similarity_score = l2DistanceToCosine(distance);
      }
      return obs;
    });
  }

  /**
   * Count observations missing embeddings (efficient SQL COUNT)
   */
  countUnembedded(project?: string): number {
    const sql = project
      ? `SELECT COUNT(*) as count FROM observations WHERE embedding IS NULL AND project LIKE ?`
      : `SELECT COUNT(*) as count FROM observations WHERE embedding IS NULL`;

    const row = project
      ? this.db.prepare(sql).get(project + '%') as { count: number }
      : this.db.prepare(sql).get() as { count: number };

    return row.count;
  }

  /**
   * Migration: add embedding column and vec0 virtual table for session-level vector search.
   * Sessions get enriched text embeddings (user prompts + actions + summary).
   */
  private migrateAddSessionVectorSearch(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('embedding')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN embedding BLOB`);
    }
    if (!columnNames.has('enriched_text')) {
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
      // vec0 may not support TEXT primary keys — fall back to integer mapping
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_sessions USING vec0(
            session_rowid INTEGER PRIMARY KEY,
            embedding float[384]
          )
        `);
        // Create a mapping table for text session IDs to integer rowids
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS vec_sessions_map (
            rowid INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE NOT NULL
          )
        `);
      } catch {
        // If both fail, session vector search just won't be available
        // Observation-level vector search still works
      }
    }
  }

  /**
   * Migration: add file_encounter_counts table for surprise scoring.
   */
  private migrateAddFileEncounterCounts(): void {
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
  private migrateAddObservationRelationships(): void {
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
  private migrateAddTagsColumn(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('tags')) {
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
  private migrateAddContentHash(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('content_hash')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN content_hash TEXT`);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_project_hash
      ON observations(project, content_hash) WHERE content_hash IS NOT NULL
    `);
  }

  private migrateAddSummaryExtended(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('summary_extended')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN summary_extended TEXT`);
    }
  }

  /**
   * Migration: add last_checkpoint_at column for periodic checkpoint tracking.
   * Stores the Unix epoch millisecond timestamp of the last checkpoint run.
   * NULL means no checkpoint has run for this session (use started_at as baseline).
   */
  private migrateAddLastCheckpointAt(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('last_checkpoint_at')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN last_checkpoint_at INTEGER`);
    }
  }

  /**
   * Migration: add source column to sessions table.
   * Distinguishes hook-driven sessions ('hook') from manually-created sessions ('manual').
   * Existing rows default to 'hook' — no backfill needed.
   */
  private migrateAddSessionSource(): void {
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('source')) {
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
  private migrateTagsToJson(): void {
    const rows = this.db.prepare(
      `SELECT id, tags FROM observations WHERE tags IS NOT NULL AND tags NOT LIKE '[%'`
    ).all() as Array<{ id: number; tags: string }>;

    if (rows.length === 0) return;

    const update = this.db.prepare(`UPDATE observations SET tags = ? WHERE id = ?`);
    const migrate = this.db.transaction(() => {
      for (const row of rows) {
        const parts = row.tags.split(',').map(t => t.trim()).filter(Boolean);
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
  private migrateAddLessonType(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('lesson_type')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN lesson_type TEXT`);
    }
    // Always ensure index exists — idempotent via IF NOT EXISTS.
    // Running this outside the column guard ensures the index is created even when
    // the column was added in a previous run but the index was never created
    // (e.g., a partial migration or a DB migrated before this index was introduced).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_lesson_type
      ON observations(project, lesson_type, created_at DESC)
      WHERE lesson_type IS NOT NULL
    `);
  }

  async getOrCreateManualSession(project: string): Promise<string> {
    // Look for any manual session for this project started today — most recent first.
    // Drop status='active' constraint so stale GC cannot fragment rapid consecutive writes.
    const existing = this.db.prepare(`
      SELECT id, status FROM sessions
      WHERE project = ?
        AND source = 'manual'
        AND date(started_at, 'localtime') = date('now', 'localtime')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(project) as { id: string; status: string } | undefined;

    if (existing) {
      // Re-activate if GC had marked it complete so subsequent GC respects freshness.
      // Also clear summary so the stale GC message does not appear in context_list or embedding text.
      if (existing.status === 'complete') {
        this.db.prepare(
          `UPDATE sessions SET status = 'active', ended_at = NULL, summary = NULL WHERE id = ?`
        ).run(existing.id);
      }
      return existing.id;
    }

    // No session for today — create one
    const sessionId = randomUUID();
    this.db.prepare(`
      INSERT INTO sessions (id, project, started_at, status, source)
      VALUES (?, ?, ?, 'active', 'manual')
    `).run(sessionId, project, new Date().toISOString());

    return sessionId;
  }

  async addManualObservation(params: {
    text: string;
    project: string;
    sessionId: string;
    importanceScore: number;
    tags: string | undefined;
    client?: string;
  }): Promise<number | undefined> {
    const { text: rawText, project, sessionId, importanceScore, tags, client } = params;
    // Defensive trim — call sites (MCP tool, HTTP handler) already validate, but guard here
    // in case addManualObservation is called directly from tests or future integrations.
    const text = rawText.trim();
    if (!text) return undefined;

    // Derive importance level from score (same thresholds used throughout)
    let importance: ImportanceLevel;
    if (importanceScore >= 0.65) {
      importance = 'high';
    } else if (importanceScore >= 0.35) {
      importance = 'medium';
    } else {
      importance = 'low';
    }

    const tokenEstimate = Math.ceil(text.length / 4);
    const createdAt = new Date().toISOString();

    // Build tool_name: 'Manual' when no client, 'Manual:ClientName' when client is provided.
    const toolName = client ? `Manual:${client}` : 'Manual';

    // SHA256 dedup — skip if identical text already stored in this project
    const contentHash = sha256(`${text}\n[]\n`);

    const hashCheck = this.db.prepare(`
      SELECT COUNT(*) as count FROM observations
      WHERE project LIKE ? AND content_hash = ?
    `).get(project + '%', contentHash) as { count: number };

    if (hashCheck.count > 0) {
      return undefined;
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
      tags ? JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)) : null,
      contentHash,
      createdAt,
    );

    const obsId = Number(info.lastInsertRowid);

    // Auto-pin observations tagged 'decision' or 'lesson' so they are exempt from decay.
    // Tags in addManualObservation are stored as a JSON array string, matching the same
    // format used by save(). This mirrors the auto-pin logic in save().
    this.db.prepare(`
      UPDATE observations SET pinned = 1
      WHERE id = ?
        AND (
          tags LIKE '%"decision"%' OR tags LIKE '%"lesson"%'
        )
    `).run(obsId);

    // Eagerly write enriched_text to the session so the background embedder can pick it
    // up without waiting for GC to close the session.
    const sessionEnrichRow = this.db.prepare(
      `SELECT enriched_text FROM sessions WHERE id = ?`
    ).get(sessionId) as { enriched_text: string | null };

    // Write enriched_text in the structured session embedding format (matches buildSessionEmbeddingText)
    // so the embedding aligns with how context_semantic_search queries are ranked.
    const newEntry = !sessionEnrichRow.enriched_text
      ? `Actions: ${text}`
      : `${sessionEnrichRow.enriched_text}. ${text}`;
    this.db.prepare(
      `UPDATE sessions SET enriched_text = ? WHERE id = ?`
    ).run(newEntry.substring(0, 2000), sessionId);

    return obsId;
  }

  async saveSessionEmbedding(sessionId: string, embedding: Float32Array, enrichedText: string): Promise<void> {
    if (!this.vecEnabled) {
      throw new Error('Vector search is not enabled (sqlite-vec not loaded)');
    }

    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const saveTransaction = this.db.transaction(() => {
      // Save embedding + enriched text on the sessions row
      this.db.prepare(
        `UPDATE sessions SET embedding = ?, enriched_text = ? WHERE id = ?`
      ).run(embeddingBuf, enrichedText, sessionId);

      // Try text PK first (vec_sessions with TEXT PRIMARY KEY)
      try {
        this.db.prepare(
          `INSERT OR REPLACE INTO vec_sessions (session_id, embedding) VALUES (?, ?)`
        ).run(sessionId, embeddingBuf);
      } catch {
        // Fall back to integer mapping approach
        this.db.prepare(
          `INSERT OR IGNORE INTO vec_sessions_map (session_id) VALUES (?)`
        ).run(sessionId);
        const mapRow = this.db.prepare(
          `SELECT rowid FROM vec_sessions_map WHERE session_id = ?`
        ).get(sessionId) as { rowid: number } | undefined;
        if (mapRow) {
          this.db.prepare(
            `INSERT OR REPLACE INTO vec_sessions (session_rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`
          ).run(mapRow.rowid, embeddingBuf);
        }
      }
    });

    saveTransaction();
  }

  async vectorSearchSessions(embedding: Float32Array, project?: string, topK: number = 10): Promise<Session[]> {
    if (!this.vecEnabled) {
      throw new Error('Vector search is not enabled (sqlite-vec not loaded)');
    }

    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Try text PK approach first
    let rows: Array<Record<string, unknown>>;
    try {
      let sql: string;
      let params: unknown[];

      if (project) {
        sql = `
          SELECT s.*, v.distance
          FROM vec_sessions v
          INNER JOIN sessions s ON s.id = v.session_id
          WHERE v.embedding MATCH ? AND k = ?
            AND s.project LIKE ?
          ORDER BY v.distance ASC
        `;
        params = [embeddingBuf, topK, project + '%'];
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

      rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } catch {
      // Fall back to integer mapping approach
      let sql: string;
      let params: unknown[];

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
        params = [embeddingBuf, topK, project + '%'];
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

      rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    }

    return rows.map(row => {
      const distance = row.distance as number | undefined;
      return {
        id: row.id as string,
        project: row.project as string,
        started_at: row.started_at as string,
        ended_at: (row.ended_at as string) || undefined,
        summary: (row.summary as string) || undefined,
        status: row.status as 'active' | 'complete',
        similarity_score: distance != null ? l2DistanceToCosine(distance) : undefined,
      };
    });
  }

  countUnembeddedSessions(project?: string): Promise<number> {
    const sql = project
      ? `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL)) AND project LIKE ?`
      : `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL))`;

    const row = project
      ? this.db.prepare(sql).get(project + '%') as { count: number }
      : this.db.prepare(sql).get() as { count: number };

    return Promise.resolve(row.count);
  }

  countEmbeddedSessions(project?: string): Promise<number> {
    const sql = project
      ? `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NOT NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL)) AND project LIKE ?`
      : `SELECT COUNT(*) as count FROM sessions WHERE embedding IS NOT NULL AND (status = 'complete' OR (source = 'manual' AND enriched_text IS NOT NULL))`;

    const row = project
      ? this.db.prepare(sql).get(project + '%') as { count: number }
      : this.db.prepare(sql).get() as { count: number };

    return Promise.resolve(row.count);
  }

  async getUnembeddedSessions(limit: number = 50, project?: string): Promise<Session[]> {
    let sql: string;
    let params: unknown[];

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
      params = [project + '%', limit];
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

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      project: string;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      enriched_text: string | null;
      source: string | null;
      status: 'active' | 'complete';
    }>;

    return rows.map(row => ({
      id: row.id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at || undefined,
      summary: row.summary || undefined,
      enriched_text: row.enriched_text || undefined,
      source: row.source || undefined,
      status: row.status,
    }));
  }

  async getUnembeddedObservations(limit: number = 100, project?: string): Promise<Observation[]> {
    let sql: string;
    let params: unknown[];

    if (project) {
      sql = `
        SELECT * FROM observations
        WHERE embedding IS NULL AND project LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [project + '%', limit];
    } else {
      sql = `
        SELECT * FROM observations
        WHERE embedding IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
  }

  /**
   * Get recent sessions with their observations, grouped for display.
   */
  async getRecentSessionsWithObservations(
    project: string,
    sessionLimit: number = 10
  ): Promise<Array<{ session: Session; observations: Observation[] }>> {
    const sessions = await this.getRecentSessions(project, sessionLimit);
    const result: Array<{ session: Session; observations: Observation[] }> = [];

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
  incrementFileEncounter(filePath: string, project: string, toolName: string): Promise<number> {
    const now = new Date().toISOString();

    // Upsert + RETURNING in one statement (SQLite 3.35+)
    const row = this.db.prepare(`
      INSERT INTO file_encounter_counts (file_path, project, tool_name, encounter_count, last_seen)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(file_path, project, tool_name)
      DO UPDATE SET encounter_count = encounter_count + 1, last_seen = ?
      RETURNING encounter_count
    `).get(filePath, project, toolName, now, now) as { encounter_count: number } | undefined;

    // For surprise scoring, use the 7-day windowed count rather than the lifetime total.
    // This way files you haven't touched in a while feel novel again.
    const recent = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM observations
      WHERE project = ? AND files_touched LIKE ? ESCAPE '\\' AND created_at > datetime('now', '-7 days')
    `).get(project, `%${filePath.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) as { cnt: number };

    // Return the higher-signal windowed count for scoring, but the lifetime
    // counter is still maintained in file_encounter_counts for analytics
    return Promise.resolve(recent.cnt);
  }

  /**
   * Infer and store relationships for a newly inserted observation.
   * Called from save() after INSERT — keeps relationship inference passive.
   */
  private inferRelationships(observationId: number, observation: Omit<Observation, 'id'>): void {
    const now = new Date().toISOString();

    // 1. followed_by: link to the immediately preceding observation in this session
    const previous = this.db.prepare(`
      SELECT id FROM observations
      WHERE session_id = ? AND id != ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(observation.session_id, observationId) as { id: number } | undefined;

    if (previous) {
      this.db.prepare(`
        INSERT OR IGNORE INTO observation_relationships (source_id, target_id, relationship, created_at)
        VALUES (?, ?, 'followed_by', ?)
      `).run(previous.id, observationId, now);
    }

    // 2. same_file: link to recent observations that touch the same files
    if (observation.files_touched.length > 0) {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      for (const file of observation.files_touched) {
        // Escape the file path for LIKE pattern (the file is stored in a JSON array)
        const likePattern = `%${file.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
        const matches = this.db.prepare(`
          SELECT id FROM observations
          WHERE project = ? AND id != ?
            AND files_touched LIKE ? ESCAPE '\\'
            AND created_at > ?
          ORDER BY created_at DESC
          LIMIT 5
        `).all(observation.project, observationId, likePattern, cutoff) as Array<{ id: number }>;

        for (const match of matches) {
          this.db.prepare(`
            INSERT OR IGNORE INTO observation_relationships (source_id, target_id, relationship, created_at)
            VALUES (?, ?, 'same_file', ?)
          `).run(match.id, observationId, now);
        }
      }

      // 3. cross_project_same_file: link observations touching the same file across
      //    different projects within a 24h window. Mirror of same_file but uses
      //    project != ? instead of project = ?.
      for (const file of observation.files_touched) {
        const likePattern = `%${file.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
        const crossMatches = this.db.prepare(`
          SELECT id FROM observations
          WHERE project != ? AND id != ?
            AND files_touched LIKE ? ESCAPE '\\'
            AND created_at > ?
          ORDER BY created_at DESC
          LIMIT 5
        `).all(observation.project, observationId, likePattern, cutoff) as Array<{ id: number }>;

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
  getRelatedObservations(observationId: number, types?: RelationshipType[], limit: number = 10): Promise<Observation[]> {
    let sql: string;
    let params: unknown[];

    if (types && types.length > 0) {
      const placeholders = types.map(() => '?').join(', ');
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

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map(row => this.mapRow(row)));
  }

  /**
   * Get prior observations about a specific file from previous sessions.
   *
   * Searches files_touched (JSON array stored as text) for the file path,
   * filtered to file-operation tools (Read, Edit, Write) from sessions other
   * than the current one. Results ordered by recency.
   */
  getFileHistory(
    filePath: string,
    projectPrefix: string,
    excludeSessionId: string,
    limit: number
  ): Promise<Observation[]> {
    // Escape file path for LIKE pattern matching
    const escapedPath = filePath
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
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
      projectPrefix + '%',
      excludeSessionId,
      likePattern,
      limit
    ) as Array<Record<string, unknown>>;

    return Promise.resolve(rows.map(row => this.mapRow(row)));
  }

  /**
   * Check whether the current session already has an observation touching the
   * given file. Uses a single indexed SQL query instead of fetching all session
   * observations into application memory.
   *
   * @param sessionId - Session ID to check
   * @param likePattern - LIKE-escaped pattern for the file path (e.g. "%file.ts%")
   */
  async hasSessionSeenFile(sessionId: string, likePattern: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT 1 FROM observations
      WHERE session_id = ?
        AND files_touched LIKE ? ESCAPE '\\'
      LIMIT 1
    `).get(sessionId, likePattern) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  async getTopConversationObservation(sessionId: string): Promise<Observation | null> {
    const row = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ?
        AND tool_name = 'Conversation'
      ORDER BY importance_score DESC
      LIMIT 1
    `).get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Get related observation references via observation_relationships.
   * Checks both source_id and target_id so direction does not matter.
   */
  getRelatedObservationRefs(id: number): Promise<Array<{ id: number; relationship: string }>> {
    const rows = this.db.prepare(`
      SELECT
        CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END AS related_id,
        r.relationship
      FROM observation_relationships r
      WHERE r.source_id = ? OR r.target_id = ?
      LIMIT 5
    `).all(id, id, id) as Array<{ related_id: number; relationship: string }>;
    return Promise.resolve(rows.map(r => ({ id: r.related_id, relationship: r.relationship })));
  }

  /**
   * Fetch full Observation objects for a list of IDs.
   * IDs that do not exist are silently skipped.
   * Results returned in ascending created_at order.
   */
  getObservationsByIds(ids: number[]): Promise<Observation[]> {
    if (ids.length === 0) return Promise.resolve([]);
    const safeIds = ids.map(id => Math.trunc(id)).filter(id => id > 0);
    if (safeIds.length === 0) return Promise.resolve([]);
    const placeholders = safeIds.map(() => '?').join(', ');
    const sql = `
      SELECT * FROM observations
      WHERE id IN (${placeholders})
      ORDER BY created_at ASC
    `;
    const rows = this.db.prepare(sql).all(...safeIds) as Array<Record<string, unknown>>;
    const observations = rows.map(row => this.mapRow(row));

    // Increment access_count for drill-down fetches (context_get tool path) so that
    // observations explicitly examined by the user receive the same frequency bonus as
    // those returned by search().
    if (observations.length > 0) {
      const foundIds = observations.map(o => o.id).filter((id): id is number => id != null);
      if (foundIds.length > 0) {
        const idPlaceholders = foundIds.map(() => '?').join(', ');
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
  getObservationNeighbors(
    id: number,
    window: number
  ): Promise<{ before: Observation[]; target: Observation; after: Observation[] } | null> {
    const targetRow = this.db.prepare(`
      SELECT * FROM observations WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!targetRow) return Promise.resolve(null);

    const target = this.mapRow(targetRow);
    const sessionId = targetRow.session_id as string;
    const capturedAt = targetRow.created_at as string;

    // Fetch `window` observations before the target in the same session.
    // Use id as a tiebreaker to avoid same-timestamp siblings appearing in both arrays.
    const beforeRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(sessionId, capturedAt, capturedAt, id, window) as Array<Record<string, unknown>>;

    // Reverse so they are in ascending chronological order
    const before = beforeRows.map(row => this.mapRow(row)).reverse();

    // Fetch `window` observations after the target in the same session.
    // Use id as a tiebreaker to avoid same-timestamp siblings appearing in both arrays.
    const afterRows = this.db.prepare(`
      SELECT * FROM observations
      WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(sessionId, capturedAt, capturedAt, id, window) as Array<Record<string, unknown>>;

    const after = afterRows.map(row => this.mapRow(row));

    return Promise.resolve({ before, target, after });
  }

  async getLessons(
    project?: string,
    query?: string,
    lessonType?: string,
    limit: number = 20,
    since?: string
  ): Promise<Observation[]> {
    const effectiveLimit = Math.max(1, Math.min(50, limit));

    let sql: string;
    const params: unknown[] = [];

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
        lessonType ?? null, lessonType ?? null,
        query ?? null, query ?? null,
        since ?? null, since ?? null,
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
        lessonType ?? null, lessonType ?? null,
        query ?? null, query ?? null,
        since ?? null, since ?? null,
        effectiveLimit
      );
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this.mapRow(row));
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
  private migrateAddPinnedAndAccessCount(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('pinned')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columnNames.has('access_count')) {
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
  private migrateAddDecisionsTable(): void {
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
  async saveDecision(decision: Decision): Promise<void> {
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

    // FTS5 index is maintained automatically by the decisions_ai trigger.
  }

  /**
   * Search decisions for a project. Without a query, returns recent decisions ordered
   * by captured_at DESC. With a query, uses FTS5 to filter.
   */
  async searchDecisions(project: string, query?: string, limit: number = 20): Promise<Decision[]> {
    const effectiveLimit = Math.max(1, Math.min(50, limit));

    let rows: Array<Record<string, unknown>>;

    if (query && query.trim().length > 0) {
      // Escape FTS5 special characters using the same pattern as search()
      const ftsQuery = query.trim().replace(/"/g, '""')
        .split(/\s+/)
        .filter(t => t.length > 0)
        .map(t => `"${t}"`)
        .join(' ');

      rows = this.db.prepare(`
        SELECT d.* FROM decisions d
        JOIN decisions_fts f ON d.id = f.rowid
        WHERE d.project LIKE ? || '%'
          AND decisions_fts MATCH ?
        ORDER BY d.captured_at DESC
        LIMIT ?
      `).all(project, ftsQuery, effectiveLimit) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.prepare(`
        SELECT * FROM decisions
        WHERE project LIKE ? || '%'
        ORDER BY captured_at DESC
        LIMIT ?
      `).all(project, effectiveLimit) as Array<Record<string, unknown>>;
    }

    return rows.map(row => ({
      id: row['id'] as number,
      session_id: row['session_id'] as string,
      project: row['project'] as string,
      decision_text: row['decision_text'] as string,
      context: (row['context'] as string | null) ?? null,
      decision_number: (row['decision_number'] as number | null) ?? null,
      captured_at: row['captured_at'] as string,
      importance_score: (row['importance_score'] as number) ?? 0.7,
      tags: (row['tags'] as string | null) ?? null,
    }));
  }

  /**
   * Get the next sequential decision number for a project.
   * Returns 1 when no decisions exist yet for the project.
   */
  async getNextDecisionNumber(project: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(decision_number), 0) + 1 AS next_num
      FROM decisions
      WHERE project LIKE ? || '%'
    `).get(project) as { next_num: number } | undefined;
    return row?.next_num ?? 1;
  }

  /**
   * Migration: add meta table for lightweight key-value persistence.
   * Idempotent, uses CREATE TABLE IF NOT EXISTS.
   */
  private migrateAddMetaTable(): void {
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
  private migrateAddBranchColumn(): void {
    const obsColumns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const obsColumnNames = new Set(obsColumns.map(c => c.name));

    if (!obsColumnNames.has('branch')) {
      this.db.exec(`ALTER TABLE observations ADD COLUMN branch TEXT`);
    }

    // Partial index: only index rows where branch is non-null (sparse, no wasted space)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_branch
      ON observations(project, branch) WHERE branch IS NOT NULL
    `);

    const sessColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const sessColumnNames = new Set(sessColumns.map(c => c.name));

    if (!sessColumnNames.has('branch')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN branch TEXT`);
    }
  }

  /**
   * Get observations suitable for reflection analysis.
   * Returns high-importance observations from the lookback window ordered by
   * importance descending then recency descending, capped at 500.
   */
  async getObservationsForReflection(
    project: string,
    lookbackDays: number,
    minImportance: number
  ): Promise<Observation[]> {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT * FROM observations
      WHERE project LIKE ? || '%'
        AND importance_score >= ?
        AND created_at >= ?
        AND is_compacted = 0
        AND superseded_by IS NULL
      ORDER BY importance_score DESC, created_at DESC
      LIMIT 500
    `).all(project, minImportance, since) as Array<Record<string, unknown>>;

    return rows.map(row => this.mapRow(row));
  }

  /**
   * Get the ISO date string of the last reflection run for a project.
   * Returns null when no reflection has been run yet.
   */
  async getLastReflectionDate(project: string): Promise<string | null> {
    const key = `reflection:${project}`;
    const row = this.db.prepare(
      `SELECT value FROM meta WHERE key = ?`
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Store the ISO date string of a completed reflection run for a project.
   */
  async setLastReflectionDate(project: string, date: string): Promise<void> {
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
  private migrateAddSupersededBy(): void {
    const columns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('superseded_by')) {
      this.db.exec(
        `ALTER TABLE observations ADD COLUMN superseded_by INTEGER REFERENCES observations(id) ON DELETE SET NULL`
      );
    }

    // Partial index: only index rows that have been superseded (sparse, no wasted space on the majority)
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
  async findConflictingFact(
    project: string,
    categoryValues: string[],
    newValue: string,
    currentObservationId?: number
  ): Promise<number | null> {
    if (categoryValues.length === 0) return null;

    // Build LIKE clauses for all category values
    const likeClauses = categoryValues
      .map(() => `summary LIKE ?`)
      .join(' OR ');

    // Exclude the new value and, when provided, the current observation to avoid self-match
    const selfExclusion = currentObservationId != null ? 'AND id != ?' : '';

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

    // Params: project, one '%value%' per category value, exclusion pattern for newValue,
    // optional self-exclusion id
    const likeParams = categoryValues.map(v => `%${v}%`);
    const excludeParam = `%${newValue}%`;
    const params: unknown[] = [project, ...likeParams, excludeParam];
    if (currentObservationId != null) params.push(currentObservationId);

    const rows = this.db.prepare(sql).all(...params) as Array<{ id: number }>;

    // Return the most recent conflicting observation ID, or null
    return rows[0]?.id ?? null;
  }

  /**
   * Mark an observation as superseded by a newer one.
   * Sets superseded_by = newId on the row with id = oldId.
   */
  async markSuperseded(oldId: number, newId: number): Promise<void> {
    this.db.prepare(
      `UPDATE observations SET superseded_by = ? WHERE id = ?`
    ).run(newId, oldId);
  }

  /**
   * Migration: create the token_index table for fuzzy search correction.
   * Safe to run on existing databases (uses IF NOT EXISTS).
   */
  private migrateAddTokenIndex(): void {
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
   * Add tokens to the token_index, incrementing frequency on conflict.
   * Runs as a transaction for efficiency. Tokens are already normalized.
   */
  addTokens(tokens: string[]): void {
    if (tokens.length === 0) return;
    const upsert = this.db.prepare(
      `INSERT INTO token_index(token, frequency) VALUES(?, 1)
       ON CONFLICT(token) DO UPDATE SET frequency = frequency + 1`
    );
    const runAll = this.db.transaction((toks: string[]) => {
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
  findClosestToken(token: string, minFrequency: number = 3): string | null {
    // Cap token length to avoid expensive DP on very long strings
    if (token.length > 50) return null;

    const minLen = Math.max(1, token.length - 2);
    const maxLen = token.length + 2;

    const rows = this.db.prepare(
      `SELECT token FROM token_index
       WHERE frequency >= ? AND length(token) BETWEEN ? AND ? AND token != ?
       LIMIT 200`
    ).all(minFrequency, minLen, maxLen, token) as Array<{ token: string }>;

    let bestToken: string | null = null;
    let bestDist = 3; // one beyond the acceptance threshold of 2

    for (const row of rows) {
      const dist = levenshtein(token, row.token);
      if (dist < bestDist) {
        bestDist = dist;
        bestToken = row.token;
      }
    }

    return bestToken;
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
