# Architecture

Detailed technical architecture for claude-context-manager.

**Status**: ACTIVE
**Last Updated**: December 5, 2025

---

## System Overview

claude-context-manager is a Claude Code plugin with a direct-access architecture:

1. **Hook Layer** - Integrates with Claude Code's lifecycle events
2. **Storage Layer** - Direct SQLite access via better-sqlite3

No background HTTP service required - hooks access the database directly.

---

## Component Details

### 1. Hook Layer (`plugin/hooks/`)

Claude Code plugins can register hooks for lifecycle events. We use three:

#### SessionStart Hook (`context-inject.ts`)
- **Trigger**: When a new Claude Code session begins
- **Matcher**: `startup|clear|compact`
- **Purpose**: Inject relevant context from previous sessions
- **Response Format**:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": "<claude-context>...</claude-context>"
    }
  }
  ```
- **Note**: This format is required for compatibility with Claude's extended thinking mode

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
- **Purpose**: Save session summary
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
  created_at: string;
}

export interface ContextStorage {
  initialize(): Promise<void>;
  save(obs: Observation): Promise<void>;
  getRecent(project: string, limit: number): Promise<Observation[]>;
  getWithinBudget(project: string, tokenBudget: number): Promise<Observation[]>;
  search(query: string, project?: string): Promise<Observation[]>;
  getStats(project?: string): Promise<Stats>;
  createSession(sessionId: string, project: string): Promise<void>;
  endSession(sessionId: string, summary?: string): Promise<void>;
  vacuum(olderThanDays?: number): Promise<number>;
  close(): void;
}
```

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
  files_touched TEXT,  -- JSON array
  metadata TEXT,       -- JSON object
  token_estimate INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_observations_project_created
  ON observations(project, created_at DESC);
CREATE INDEX idx_observations_session ON observations(session_id);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE observations_fts USING fts5(
  summary,
  files_touched,
  metadata,
  content=observations,
  content_rowid=id
);

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
+---------------------+
| PostToolUse Hook    |
| (capture-tool.ts)   |
+---------------------+
| 1. Parse stdin JSON |
| 2. Validate input   |
| 3. Check tool type  |
+---------------------+
         |
         v (direct SQLite)
+---------------------+
| SQLiteStorage       |
+---------------------+
| 1. Process input    |
| 2. Generate summary |
| 3. Estimate tokens  |
| 4. INSERT to DB     |
+---------------------+
         |
         v
+---------------------+
| SQLite Database     |
+---------------------+
| INSERT observation  |
| FTS trigger fires   |
+---------------------+
```

### Injection Flow (SessionStart)

```
New Claude Code session
         |
         v
+---------------------+
| SessionStart Hook   |
| (context-inject.ts) |
+---------------------+
| 1. Parse stdin JSON |
| 2. Validate project |
+---------------------+
         |
         v (direct SQLite)
+---------------------+
| SQLiteStorage       |
+---------------------+
| 1. Query by project |
| 2. Apply token budg |
| 3. Build context    |
+---------------------+
         |
         v
+---------------------+
| SQLite Database     |
+---------------------+
| SELECT observations |
| ORDER BY created_at |
| LIMIT by tokens     |
+---------------------+
         |
         v
+---------------------+
| Context Builder     |
+---------------------+
| Format as markdown  |
| Wrap in JSON resp   |
+---------------------+
         |
         v (stdout)
{ hookSpecificOutput: { additionalContext: "..." } }
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

- Index on `project` + `created_at` for common query
- FTS5 for keyword search (sub-100ms typical)
- LIMIT clauses to bound result size
- Token budget limits total results

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

## Future Extensions

Potential enhancements (not in current scope):

1. **Semantic Search** - Add embeddings for similarity search
2. **Cross-Project** - Optional global context across all projects
3. **Viewer UI** - Web interface to browse/search observations
4. **Export** - Export observations as markdown/JSON
5. **Smart Install** - Auto-rebuild native modules on Node.js upgrade
