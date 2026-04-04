# Architecture

Detailed technical architecture for claude-context-manager.

**Status**: ACTIVE
**Last Updated**: April 4, 2026

---

## System Overview

claude-context-manager is a Claude Code plugin with a direct-access architecture:

1. **Hook Layer** - Integrates with Claude Code's lifecycle events
2. **Storage Layer** - Direct SQLite access via better-sqlite3

No background HTTP service required - hooks access the database directly.

---

## Why SQLite?

SQLite was chosen deliberately over alternatives like HTTP-backed services (Redis, PostgreSQL) or vector databases (ChromaDB). The key constraints are that Claude Code hooks run as short-lived Node.js scripts with tight timeouts (5-10s), and users shouldn't need to install or manage external services.

| Requirement | SQLite | HTTP Service | Vector DB (ChromaDB) |
|-------------|--------|--------------|----------------------|
| No background daemon | Yes — open, read/write, close | No — needs persistent process | No — needs server + Python |
| Zero install dependencies | Yes — single file on disk | No — service management | No — ChromaDB + embeddings |
| Full-text search | FTS5 built in | Depends on backend | Native (vector similarity) |
| Synchronous access | better-sqlite3 is sync | Async HTTP calls | Async HTTP calls |
| Concurrent hook access | WAL mode handles this | Natural | Natural |
| Cold start latency | <5ms (file open) | Connection overhead | Connection + model load |

**Trade-offs accepted:**
- No AI-powered extraction (mitigated by rule-based summarization and importance classification)
- Single-machine only (acceptable — Claude Code is a local CLI tool)

**Vector search (added v0.5.5, enriched v0.6.0):** sqlite-vec extends SQLite with vector similarity search, keeping the single-file architecture. Session-level embeddings are generated from enriched text (user prompts + high-value actions + session summary) using a local ONNX model — no external APIs or services required.

**Contrast with claude-mem:** The reference project uses ChromaDB + Agent SDK HTTP service, enabling AI-powered extraction via Anthropic API calls. That's more powerful for per-observation summarization but requires Python, ChromaDB, Bun, and a running daemon. We achieve similar semantic search quality at the session level through data assembly (no AI needed) because user prompts and session summaries already contain natural language.

---

## Component Details

### 1. Hook Layer (`plugin/hooks/`)

Claude Code plugins can register hooks for lifecycle events. We use three:

#### SessionStart Hook (`context-inject.ts`)
- **Trigger**: When a new Claude Code session begins
- **Matcher**: `startup|clear|compact`
- **Purpose**: Create session record, inject minimal status hint (~30 tokens)
- **Note**: Since v0.4.0, high-value context is exported to auto-memory at session end, not injected here
- **Response Format**:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": "context-manager v0.4.0 active. 570 observations tracked..."
    }
  }
  ```

#### PostToolUse Hook (`capture-tool.ts`)
- **Trigger**: After every tool execution (Read, Write, Bash, etc.)
- **Purpose**: Capture tool interactions for future reference
- **Response Format**:
  ```json
  {
    "status": "captured" | "skipped" | "error"
  }
  ```

#### Stop Hook (`session-end.ts`)
- **Trigger**: When Claude Code session ends normally
- **Purpose**: Extract conversation insights, save session summary, export to auto-memory
- **Conversation Insights** (v0.6.4): Scans all assistant text blocks in the transcript for high-signal content:
  - Markdown tables (comparisons, specs, pricing)
  - Recommendation/decision language
  - Price/cost analysis
  - User fact confirmations ("you don't have...", "you confirmed...")
  - Structured content (headers, bullet lists with data)
  - Each qualifying block is scored (0.0-1.0), compressed to ~150 tokens, and saved as a `Conversation` observation
  - Top 10 blocks per session (by score) to bound token budget
- **Export**: Writes to `~/.claude/projects/<path>/memory/context-manager-activity.md`
- **Response Format**:
  ```json
  {
    "status": "complete" | "error"
  }
  ```

### 2. Storage Layer (`src/storage/`)

#### Storage Interface (`src/storage/interface.ts`)

Abstraction layer for storage operations:

```typescript
export type ImportanceLevel = 'high' | 'medium' | 'low';

export interface Observation {
  id?: number;
  project: string;
  package?: string;  // For monorepo support
  session_id: string;
  tool_name: string;
  summary: string;
  files_touched: string[];
  metadata: Record<string, unknown>;
  token_estimate: number;
  importance: ImportanceLevel;      // Classified at capture time
  importance_score: number;         // 0.0 to 1.0
  is_compacted?: boolean;           // True if this is a compacted summary
  exported_at?: string;             // When exported to auto-memory
  created_at: string;
}

export interface ContextStorage {
  // Core operations (hooks)
  initialize(): Promise<void>;
  save(obs: Observation): Promise<void>;
  getRecent(project: string, limit: number): Promise<Observation[]>;
  getWithinBudget(project: string, tokenBudget: number): Promise<Observation[]>;
  getRelevantCandidates(project: string, limit?: number): Promise<Observation[]>;
  search(query: string, project?: string): Promise<Observation[]>;
  getStats(project?: string): Promise<Stats>;

  // Session management
  createSession(sessionId: string, project: string): Promise<void>;
  endSession(sessionId: string, summary?: string): Promise<void>;
  getRecentSessions(project: string, limit: number): Promise<Session[]>;
  getSessionObservations(sessionId: string): Promise<Observation[]>;
  getSessionPrompts(sessionId: string): Promise<UserPrompt[]>;

  // User prompts (Web UI)
  saveUserPrompt(prompt: Omit<UserPrompt, 'id'>): Promise<void>;
  getRecentPrompts(project: string, limit: number): Promise<UserPrompt[]>;
  searchPrompts(query: string, project?: string): Promise<UserPrompt[]>;

  // Analytics (Web UI)
  getTimeline(project?: string, days?: number): Promise<TimelineEntry[]>;
  getProjects(): Promise<ProjectEntry[]>;
  countObservations(project?: string, tool?: string): Promise<number>;
  countSessions(project?: string, status?: string): Promise<number>;

  // Auto-memory export
  getUnexportedHighImportance(project: string, sessionId?: string, minScore?: number): Promise<Observation[]>;
  markExported(ids: number[]): Promise<void>;

  // Maintenance
  vacuum(olderThanDays?: number): Promise<{ observations; sessions; compacted; compacted_originals }>;
  compactObservations(olderThanDays?: number): Promise<{ compacted; originals }>;
  close(): void;
}
```

**Key methods:**
- `getUnexportedHighImportance()` - Fetches observations with score >= 0.65 not yet exported to auto-memory
- `markExported()` - Sets `exported_at` timestamp after successful export
- `getRelevantCandidates()` - Fetches up to 200 candidates (excluding low-importance) for relevance scoring
- `compactObservations()` - Groups old observations by session + tool into compressed summaries
- `vacuum()` - Also triggers compaction and returns compaction stats

#### SQLite Implementation (`src/storage/sqlite.ts`)

Direct SQLite access using better-sqlite3:
- WAL mode for concurrent access
- FTS5 for full-text search
- Prepared statements for performance
- Synchronous API (better-sqlite3 is sync)

---

## Database Schema

SQLite database with FTS5 extension for full-text search.

```sql
-- Sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  status TEXT DEFAULT 'active'
);

CREATE INDEX idx_sessions_project ON sessions(project);
CREATE INDEX idx_sessions_started_at ON sessions(started_at);
CREATE INDEX idx_sessions_status ON sessions(status);

-- Observations table
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  package TEXT,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  files_touched TEXT,          -- JSON array
  metadata TEXT,               -- JSON object
  token_estimate INTEGER DEFAULT 0,
  importance TEXT DEFAULT 'medium',   -- 'high', 'medium', 'low'
  importance_score REAL DEFAULT 0.5,  -- 0.0 to 1.0
  is_compacted INTEGER DEFAULT 0,     -- 1 if compacted summary
  exported_at TEXT,                   -- When exported to auto-memory
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_observations_project_created
  ON observations(project, created_at DESC);
CREATE INDEX idx_observations_session ON observations(session_id);
CREATE INDEX idx_observations_project_score
  ON observations(project, importance_score DESC, created_at DESC);

-- FTS5 virtual tables for full-text search
CREATE VIRTUAL TABLE observations_fts USING fts5(
  summary,
  files_touched,
  metadata,
  content=observations,
  content_rowid=id
);

CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
  prompt_text,
  content=user_prompts,
  content_rowid=id
);

-- context_search queries BOTH tables, merging results

-- Triggers to keep FTS in sync
CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, summary, files_touched, metadata)
  VALUES (
    new.id,
    COALESCE(new.summary, ''),
    COALESCE(new.files_touched, ''),
    COALESCE(new.metadata, '')
  );
END;

-- (Similar triggers for UPDATE and DELETE)
```

---

## Data Flow

### Capture Flow (PostToolUse)

```
Claude Code executes tool
         |
         v
+-------------------------+
| PostToolUse Hook        |
| (capture-tool.ts)       |
+-------------------------+
| 1. Parse stdin JSON     |
| 2. Validate input       |
| 3. Check skip filters   |
+-------------------------+
         |
         v
+-------------------------+
| Capture Processor       |
| (processor.ts)          |
+-------------------------+
| 1. Sanitize response    |
| 2. Generate summary     |
| 3. Extract files        |
| 4. Estimate tokens      |
| 5. Score importance     |
|    (calculateImportance)|
+-------------------------+
         |
         v (direct SQLite)
+-------------------------+
| SQLiteStorage           |
+-------------------------+
| 1. Deduplication check  |
| 2. INSERT with          |
|    importance +          |
|    importance_score      |
| 3. FTS trigger fires    |
+-------------------------+
```

### Injection Flow (SessionStart) — v0.4.0

```
New Claude Code session
         |
         v
+-------------------------------+
| SessionStart Hook             |
| (context-inject.ts)           |
+-------------------------------+
| 1. Parse stdin JSON           |
| 2. Create session record      |
| 3. Count observations         |
| 4. Build status hint          |
+-------------------------------+
         |
         v (stdout, ~30 tokens)
{ hookSpecificOutput: {
    additionalContext: "context-manager v0.4.0 active. 570 observations tracked..."
  }
}

(High-value context is now provided via auto-memory topic files,
 written at session end by the Stop hook)
```

### Export Flow (Stop Hook) — v0.4.0

```
Claude Code session ends
         |
         v
+-------------------------------+
| Stop Hook                     |
| (session-end.ts)              |
+-------------------------------+
| 1. Extract conversation       |
|    insights from transcript   |
|    (tables, recommendations,  |
|    decisions, user facts)     |
| 2. Save as Conversation obs   |
|    (top 10 by score)          |
| 3. End session with summary   |
| 4. Export to auto-memory      |
+-------------------------------+
         |
         v (direct SQLite)
+-------------------------------+
| getUnexportedHighImportance() |
|   WHERE importance_score >= 0.65 |
|   AND exported_at IS NULL     |
+-------------------------------+
         |
         v
+-------------------------------+
| Export Module (memory.ts)     |
+-------------------------------+
| 1. Format as dated markdown   |
| 2. Append to topic file       |
| 3. Trim if > 150 lines        |
| 4. Mark exported in DB        |
+-------------------------------+
         |
         v (file write)
~/.claude/projects/<path>/memory/context-manager-activity.md
```

---

## Observation Processing

### Tool-Specific Summarization

Different tools produce different observation summaries:

| Tool | Summary Format | Key Data |
|------|---------------|----------|
| `Read` | "Read {filename} ({type})" | File path, file type |
| `Write` | "Write {filename}" | File path |
| `Edit` | "Edit {filename}" | File path |
| `Bash` | "Bash: {command_preview}" | Command (truncated) |
| `Grep` | "Grep: \"{pattern}\" in {path}" | Pattern, search path |
| `Glob` | "Glob: \"{pattern}\" in {path}" | Pattern, base path |
| `Task` | "Task: {description}" | Task description |

### Token Estimation

Simple heuristic: `tokens = characters / 4`

This is sufficient for budgeting purposes. More accurate estimation could use tiktoken if needed.

### Capture Filtering

Low-value tool interactions are filtered at the gate before reaching the database. Filtering is implemented in `src/utils/validation.ts` via `shouldCaptureTool()`.

**Skipped entirely:**
- Meta/orchestration tools: Task*, AgentOutputTool, Skill, EnterPlanMode, etc.
- Bash: `cd`, `pwd`, `ls`, `echo`, `clear`, `history`, `which`, `type`, `find`
- Bash (read-only): `cat`, `head`, `tail`, `wc`, `file`, `stat`, `diff`
- Bash (listing): `git stash list`, `git branch` (non-delete), `docker ps/images`, `kubectl get`
- Read: files in `node_modules/`, `.git/`, `dist/build/out/.next/`, lock files
- Glob: overly broad patterns (`*`, `*.*`)
- Edit: agent worklog/summary files

### Importance Scoring

Every captured observation is classified with an importance level and numeric score (0.0-1.0) at capture time by `calculateImportance()` in `src/capture/processor.ts`.

**Base scores by tool/pattern:**

| Tool/Pattern | Score | Rationale |
|---|---|---|
| Git commit/merge/rebase | 0.90 | Version control milestones |
| Edit/Write | 0.80 | File changes are high signal |
| npm install, pip install | 0.75 | Dependency changes |
| npm build/test, cargo build | 0.70 | Build/test results |
| Bash (general) | 0.50 | Depends on command |
| Git status/log/diff | 0.35 | Exploratory |
| Read | 0.30 | Usually exploration |
| Grep | 0.25 | Search/exploration |
| Glob | 0.20 | File listing |

**Adjustments:**
- Error/failure in response: +0.25
- Config files (package.json, tsconfig, Dockerfile, etc.): +0.15
- Test files: +0.10
- Lock files / generated code: -0.30

**Levels:** score >= 0.65 = high, >= 0.35 = medium, < 0.35 = low

### Relevance-Based Injection (Deprecated in v0.4.0)

> **Note**: Since v0.4.0, SessionStart no longer injects observation lists. Context is now exported to auto-memory topic files at session end. The relevance scoring code is retained for the web dashboard and potential future use.

Context injection uses multi-factor scoring instead of pure recency. Implemented in `src/inject/builder.ts` via `selectRelevantWithinBudget()`.

**Scoring formula:**
```
final_score = (importance_score * 0.70) + (recency_multiplier * 0.30) + file_overlap_boost
```

- **Recency decay**: 48-hour half-life (`Math.pow(0.5, ageHours / 48)`)
- **File overlap boost**: +0.20 if observation touches files seen in recent sessions
- **Compacted summary bonus**: +0.10 (token-efficient, represents multiple actions)
- **Diversity cap**: No single tool type can consume >60% of budget

The SQL pre-filter excludes `importance='low'` observations and fetches 200 candidates for scoring. Low-importance observations remain searchable via `context_search` and the web dashboard.

### Rule-Based Compaction

Old observations (>7 days) are compressed into summaries during `vacuum()`. Implemented in `src/storage/sqlite.ts` via `compactObservations()`.

**Rules:**
- Groups observations by session + tool type
- Only compacts groups of 3+ observations
- Never compacts high-importance observations
- Compacted format: `"Read x4: file1.ts, file2.ts, file3.ts, file4.ts"` (~15 tokens vs ~80)
- Original observations are deleted after compaction

---

## Privacy Implementation

### Tag Stripping (ReDoS-Safe)

Before storing any content, strip `<private>` tags using a safe, iterative approach:

```typescript
function stripPrivateTags(content: string): string {
  // ReDoS-safe implementation: process character by character
  let result = '';
  let i = 0;
  const openTag = '<private>';
  const closeTag = '</private>';

  while (i < content.length) {
    const remainingLength = content.length - i;

    if (remainingLength >= openTag.length &&
        content.substring(i, i + openTag.length).toLowerCase() === openTag) {
      const closeIndex = content.toLowerCase().indexOf(closeTag, i + openTag.length);

      if (closeIndex !== -1) {
        result += '[REDACTED]';
        i = closeIndex + closeTag.length;
        continue;
      }
    }

    result += content[i];
    i++;
  }

  return result;
}
```

### What Gets Stored

| Stored | Not Stored |
|--------|------------|
| File paths | Full file contents |
| Tool names | Full tool outputs |
| Brief summaries | Content in `<private>` tags |
| Timestamps | Detected secrets |
| Session IDs | - |

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_DB` | `~/.claude-context/context.db` | Database path |
| `CONTEXT_MANAGER_TOKEN_BUDGET` | `4000` | Max tokens to inject |

### Allowed Project Roots

For security, only projects under these paths are captured:

```typescript
const ALLOWED_PROJECT_ROOTS = [
  '~/Projects',
  '~/projects',
  '~/Dev',
  '~/dev',
  '~/Code',
  '~/code',
  '~/Workspace',
  '~/workspace'
];
```

---

## Security Considerations

### Input Validation
- Validate all hook inputs against expected schema
- Validate project paths against allowed root directories
- Reject paths outside approved project roots

### Path Normalization
- Use `fs.realpathSync()` to resolve symlinks
- Prevent directory traversal attacks
- Validate normalized paths

### Database Security
- Enable `PRAGMA foreign_keys = ON`
- Use parameterized queries via prepared statements
- Handle NULL values in FTS triggers with COALESCE

---

## Error Handling

### Hook Failures

Hooks fail gracefully:
- Log errors to stderr
- Return empty/neutral response
- Never block Claude Code operation
- Exit with code 0 to prevent hook failures from blocking Claude

### Database Errors

- WAL mode for concurrent access
- Database auto-creates on first use
- Degrade gracefully if database is unavailable

---

## Performance Considerations

### Hook Latency

- SessionStart: Target <500ms for context injection
- PostToolUse: Target <100ms, non-blocking
- Stop: Can take longer, session is ending

### Database Queries

- Index on `project` + `created_at` for recency queries
- Index on `project` + `importance_score` + `created_at` for relevance queries
- FTS5 for keyword search (sub-100ms typical)
- Pre-filter `importance != 'low'` at SQL level to reduce candidate pool
- LIMIT 200 candidates for in-memory relevance scoring
- Token budget limits final selected results

### Memory Usage

- SQLite with WAL uses minimal memory
- No in-memory caching (rely on OS page cache)
- better-sqlite3 is efficient with large results

---

## Installation

The install script (`scripts/install.js`):

1. Copies `dist/` to `~/.claude/plugins/context-manager/`
2. Creates symlink to `node_modules` (for better-sqlite3)
3. Adds hooks to `~/.claude/settings.json` (idempotently)
4. Creates `~/.claude-context/` directory

The uninstall script (`scripts/uninstall.js`):

1. Removes hooks from `~/.claude/settings.json`
2. Removes `~/.claude/plugins/context-manager/`
3. Optionally removes `~/.claude-context/` (with `--remove-data` flag)

---

## Web UI Dashboard (IMPLEMENTED)

Local web interface for browsing context observations and analytics.

**Status**: ✅ Implemented (v0.3.0)

### Features
- **Sessions View**: Browse all Claude Code sessions with summaries
- **Search**: Full-text search across observations and prompts
- **Analytics**: Token usage timeline, activity charts, tool distribution
- **Project Stats**: Per-project observation counts and activity

### Architecture
- **Server**: Fastify (port 3847)
- **Storage**: Direct SQLite access via shared storage layer
- **Client**: Single-page HTML with vanilla JavaScript

### Usage
```bash
npm run web       # Production mode
npm run web:dev   # Development with live reload
```

See `web/server/index.ts` for server implementation and `web/client/index.html` for UI.

---

## Future Extensions (Backlog)

Potential enhancements for future consideration. Prioritized by estimated value.

### High Value

| Feature | Description | Inspiration | Priority |
|---------|-------------|-------------|----------|
| **Pinned Context** | Manual notes that ALWAYS inject (e.g., "Using repository pattern") | claude-mem | |
| ~~**Summary Compression**~~ | ~~Abbreviate verbose summaries~~ **IMPLEMENTED** as rule-based compaction: `"Read x4: file1.ts, file2.ts, ..."` | SuperClaude | |
| ~~**Progressive Disclosure**~~ | ~~Inject less by default~~ **PARTIALLY IMPLEMENTED** via importance filtering: low-importance observations excluded from injection but still searchable | SuperClaude | |
| **AI-Powered Summarization** | Use Claude to generate better observation summaries | claude-mem | |

### Medium Value

| Feature | Description | Inspiration |
|---------|-------------|-------------|
| ~~**Confidence Scoring**~~ | ~~Track pattern usefulness (0.0→1.0)~~ **IMPLEMENTED** as importance scoring (0.0-1.0 scale with high/medium/low levels) | ELF |
| **Outcome Tracking** | Store success/failure of actions to learn what approaches work | ELF |
| **Pheromone Trails / Hotspots** | Track file activity to identify problem clusters ("this file is often touched during debugging") | ELF |
| **Semantic/Vector Search** | Embeddings for conceptually similar observations | claude-mem (ChromaDB) |
| ~~**Export**~~ | ~~Export observations as markdown/JSON~~ **IMPLEMENTED** as auto-memory export to topic files (v0.4.0) | - |

### Lower Priority

| Feature | Description | Notes |
|---------|-------------|-------|
| **Cross-Project Context** | Optional global context across all projects | Privacy concerns |
| **Endless Mode** | Aggressive compression for very long sessions | claude-mem beta |
| **MCP Integration** | Expose context via MCP server | Alternative to hooks |
| **Smart Install** | Auto-rebuild native modules on Node.js upgrade | Convenience |

### Token Reduction Techniques to Explore

Based on [SuperClaude Issue #286](https://github.com/SuperClaude-Org/SuperClaude_Framework/issues/286):

1. **Template Compression** - Abbreviated formats: `ID:architect|PRI:maintainability>perf`
2. **Reference Consolidation** - Avoid repeating same context patterns
3. **YAML Simplification** - Strip metadata, keep only essential fields
4. **Symbol System** - `→, ⇒, ∴` instead of verbose connectors (mixed results)
5. **Truncate Session Summaries** - First 200 chars instead of full text

Based on [artemgetmann's gist](https://gist.github.com/artemgetmann/74f28d2958b53baf50597b669d4bce43):

1. **Modular Loading** - `@filename` on-demand vs inline injection
2. ~~**Periodic Compaction**~~ - **IMPLEMENTED** as rule-based compaction during vacuum
3. **Precise Prompting** - Guide users to specific queries

### Complementary Tools

These tools solve different problems and could work alongside context-manager:

| Tool | Focus | Overlap |
|------|-------|---------|
| [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework) | Personas + commands (how Claude thinks) | Token reduction techniques |
| [Superpowers](https://github.com/obra/superpowers) | Structured workflow (TDD, planning) | None |
| [claude-mem](https://github.com/thedotmack/claude-mem) | Full-featured memory (vector search, UI) | Direct competitor |
| [ELF](https://github.com/Spacehunterz/Emergent-Learning-Framework_ELF) | Outcome-based learning, confidence scoring | Learning patterns (potential) |

---

**Last Updated**: April 4, 2026
