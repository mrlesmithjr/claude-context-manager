# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

**Status**: ACTIVE
**Last Updated**: May 24, 2026 (v0.8.16)

---

## Project Overview

**claude-context-manager** is a Claude Code plugin that provides structured session history and searchable context. It automatically captures tool interactions in SQLite with full-text search, and exports high-importance observations to Claude Code's auto-memory topic files.

**Owner**: Larry Smith Jr.
**Email**: mrlesmithjr@gmail.com
**Repository**: `github.com/mrlesmithjr/claude-context-manager`

---

## Development Workflow

This is a TypeScript Claude Code plugin. All code changes follow the mandatory multi-agent sequence:

**Feature or fix:**
```
typescript-developer → code-reviewer → doc-writer → version bump → commit
```

**Documentation only:**
```
doc-writer → commit (no version bump)
```

**Agent responsibilities:**
- `typescript-developer` - implement changes in `src/`, `plugin/hooks/`, `web/`, `cli/`
- `code-reviewer` - quality and security review before any commit (mandatory, never skip)
- `doc-writer` - update this CLAUDE.md, README.md, and any affected skill/agent descriptions

**Version management:**
- Bump patch version after code review passes, before committing: `npm version patch --no-git-tag-version`
- The plugin system caches by version number - if you change code without bumping the version, `/plugin update context-manager` will not apply the changes
- Never bump version before code review is complete

**Issue tracking:**
- Every code change must reference a GitHub issue in the commit (`fixes #N` or `refs #N`)
- Check open issues first: `gh issue list --repo mrlesmithjr/claude-context-manager --state open`

---

## Quick Reference

```bash
# Install from GitHub (recommended):
#   In Claude Code:
#   /plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
#   /plugin install context-manager
#   Then restart Claude Code

# For local development:
npm run build:plugin
#   In Claude Code:
#   /plugin marketplace add ~/Projects/Personal/claude-context-manager
#   /plugin install context-manager
#   Then restart Claude Code

# Update plugin:
#   /plugin update context-manager
#   Then restart Claude Code
#   NOTE: If update doesn't apply, bump version first (npm version patch)

# Uninstall:
#   In Claude Code: /plugin uninstall context-manager
#   Then optionally run:
npm run plugin:uninstall  # Keep data
npm run plugin:uninstall:all  # Remove all data
```

### MCP Tools (available after install)
- `context_stats` - Show statistics (includes vector search status)
- `context_list` - List recent observations
- `context_search` - Search observations and user prompts (FTS5 keyword)
- `context_semantic_search` - Search sessions by meaning (enriched vector similarity)
- `context_embed` - Generate vector embeddings for semantic search
- `context_vacuum` - Clean up old data
- `context_export` - Export to auto-memory
- `context_memory_audit` - Scan for orphaned memory directories when launch point changes
- `context_memory_consolidate` - Migrate orphaned memories to parent project (dry-run by default)

### Web Dashboard
```bash
npm run web        # Start web dashboard at http://localhost:3847
npm run web:dev    # Development mode with live reload
```

### Import Historical Transcripts
```bash
# Import from backup with path remapping and filtering
npm run import -- \
  --source ~/.claude.backup/projects/-Users-...-OldProject \
  --project ~/Projects/NewProject \
  --filter "optional-keyword" \
  --dry-run  # Remove to actually import
```

---

## Architecture

Direct SQLite access - no background HTTP service required.

```mermaid
flowchart LR
    subgraph hooks["Claude Code Hooks"]
        SI["SessionStart\nstatus hint ~30 tokens"]
        UP["UserPromptSubmit\ncapture prompt"]
        PT["PostToolUse\nsummarize + score + tag"]
        SE["Stop\nnarrative + insights + export"]
    end

    subgraph db["SQLite ~/.claude-context/context.db"]
        OBS["observations\nimportance · tags · embedding"]
        SES["sessions\nsummary · enriched_text · embedding"]
        UPT["user_prompts\nFTS5-indexed"]
        FEC["file_encounter_counts\nsurprise scoring"]
        REL["observation_relationships\nsame_file · followed_by"]
        FTS["observations_fts\nFTS5 virtual"]
        VEC["vec_observations\nvec_sessions\nsqlite-vec virtual"]
    end

    subgraph mcp["MCP Tools"]
        CS["context_search\nkeyword · semantic · hybrid · tag:X"]
        CL["context_list"]
        CE["context_embed"]
    end

    SI & UP & PT & SE --> db
    PT --> OBS
    PT --> FEC
    PT --> REL
    SE --> SES
    UP --> UPT
    OBS --> FTS
    OBS --> VEC
    SES --> VEC
    db --> CS & CL & CE
    SE -->|"score ≥ 0.65"| MEM["~/.claude/projects/\n…/memory/context-manager-activity.md"]
```

---

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Language | TypeScript | Type safety, Claude Code ecosystem |
| Database | SQLite + FTS5 + sqlite-vec | No daemon needed — hooks open/query/close in <5ms. FTS5 gives full-text search free. sqlite-vec adds vector similarity. WAL mode handles concurrent hook access. See `docs/ARCHITECTURE.md` "Why SQLite?" for full rationale. |
| Embeddings | @huggingface/transformers (optional) | Local ONNX inference, Xenova/all-MiniLM-L6-v2, 384-dim. No external APIs. |
| Build | esbuild | Fast bundling, ESM output |
| Native Module | better-sqlite3, sqlite-vec | Synchronous API ideal for hooks with tight timeouts (5-10s) |

---

## Directory Structure

```
claude-context-manager/
+-- .claude-plugin/
|   +-- marketplace.json       # Marketplace definition
+-- cli/
|   +-- index.ts               # CLI entry point
+-- plugin/
|   +-- .claude-plugin/
|   |   +-- plugin.json        # Plugin metadata
|   +-- hooks/
|   |   +-- hooks.json         # Hook definitions
|   |   +-- context-inject.ts  # SessionStart: inject past context
|   |   +-- capture-prompt.ts  # UserPromptSubmit: capture prompts
|   |   +-- capture-tool.ts    # PostToolUse: capture interactions
|   |   +-- session-end.ts     # Stop: save summary
|   +-- scripts/               # Built hooks (gitignored)
+-- scripts/
|   +-- install.js             # Prep script (dirs, version sync)
|   +-- uninstall.js           # Cleanup script
|   +-- import-transcripts.ts  # Import historical transcripts from backups
+-- src/
|   +-- capture/
|   |   +-- processor.ts       # Process tool outputs
|   +-- embedding/
|   |   +-- enrichment.ts      # Session enrichment text builder
|   |   +-- service.ts         # Vector embedding service (HF transformers)
|   +-- export/
|   |   +-- memory.ts          # Auto-memory export pipeline
|   +-- memory/
|   |   +-- audit.ts           # Memory directory audit (orphan detection)
|   |   +-- consolidate.ts     # Memory consolidation (migration + index rebuild)
|   |   +-- index.ts           # Exports
|   +-- inject/
|   |   +-- builder.ts         # Build context for injection (deprecated)
|   +-- storage/
|   |   +-- interface.ts       # Storage interface definition
|   |   +-- sqlite.ts          # SQLite implementation + sqlite-vec
|   +-- utils/
|       +-- hash.ts            # sha256() for exact dedup, l2DistanceToCosine() for vector search
|       +-- sanitize.ts        # Privacy tag stripping
|       +-- validation.ts      # Input validation
+-- web/
|   +-- client/
|   |   +-- index.html         # Web UI dashboard
|   +-- server/
|       +-- index.ts           # Fastify server
|       +-- routes/
|           +-- api.ts         # REST API endpoints
+-- docs/
|   +-- ARCHITECTURE.md        # Detailed architecture
|   +-- ADR-001-web-ui-dashboard.md # Web UI design decision record
+-- dist/                      # Built CLI and web server (gitignored)
+-- package.json
+-- tsconfig.json
+-- CLAUDE.md                  # This file
+-- README.md                  # User documentation
```

---

## Key Design Decisions

### 1. Direct SQLite (No HTTP Service)
- Hooks access SQLite directly via better-sqlite3
- Simpler than HTTP service architecture
- No background process to manage

### 2. Hierarchical Project Scoping
- Observations are scoped by `project` (derived from `cwd`)
- Uses **prefix matching** (`WHERE project LIKE path%`)
- Parent directories see all child project contexts
- Sibling projects are naturally isolated

**Visibility example:**
| Working From | Sees |
|--------------|------|
| `~/Projects/Work/ProjectA` | Only ProjectA contexts |
| `~/Projects/Work` | All Work/* children (ProjectA, ProjectB, etc.) |
| `~/Projects` | Everything |

### 3. hookSpecificOutput Format
- SessionStart hook returns:
  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "SessionStart",
      "additionalContext": "<claude-context>...</claude-context>"
    }
  }
  ```
- This format is compatible with Claude's extended thinking mode
- Learned from claude-mem implementation

### 4. Observation Summarization (v0.8.2)
- Extract: tool name, files touched, patterns — no AI extraction (unlike claude-mem)
- **Edit summaries** use pattern matching on the diff to produce meaningful descriptions:
  - Function/class/const additions → `"Added async getRecentSessionsWithObservations"`
  - Import changes → `"Added import from '../utils/session-format.js'"`
  - Interface/type additions, schema changes (CREATE/ALTER TABLE)
  - Net line count for larger diffs (`"Added ~12 lines"`)
  - First meaningfully different line as fallback
  - Finds actually-different lines (set difference) rather than raw first-line truncation
- Trade-off: Less intelligent than AI extraction, but deterministic and fast

### 5. Importance Scoring at Capture Time
- Every observation gets an importance level (high/medium/low) and numeric score (0.0-1.0)
- Base scores by tool type: Edit/Write (0.80), git commit (0.90), Read (0.30), Grep (0.25)
- Adjustments: errors (+0.25), config files (+0.15), test files (+0.10), lock files (-0.30)
- Scored at capture time (no post-hoc reprocessing needed)

### 5a. Conversation Insight Extraction (v0.6.4)
- At session end, the Stop hook scans all assistant text blocks in the transcript
- Scores each block for high-signal patterns: markdown tables, recommendations, price comparisons, user fact confirmations
- Top 10 blocks (by score) saved as `Conversation` observations with compressed summaries (~150 tokens each)
- This captures synthesized knowledge (comparisons, decisions, recommendations) that previously only existed in raw conversation and was lost between sessions
- Compression extracts tables, headers, bullet points with data, and decision language — discards filler text

### 6. Auto-Memory Export (v0.4.0)
- High-importance observations (score >= 0.65) exported to `~/.claude/projects/<path>/memory/context-manager-activity.md`
- Export happens at session end (Stop hook), not session start
- Writes to a dedicated topic file — never touches MEMORY.md
- SessionStart injects a minimal status hint (~30 tokens) instead of raw observation lists
- Complements Claude Code's built-in auto-memory rather than competing with it

### 8. Vector Embedding Search (v0.5.5, enriched in v0.6.0)
- sqlite-vec extension loaded at database open (graceful fallback if unavailable)
- **Observation embeddings**: `embedding BLOB` column on observations + `vec_observations` vec0 virtual table (384-dim)
- **Session embeddings** (v0.6.0): `embedding BLOB` + `enriched_text TEXT` on sessions + `vec_sessions` vec0 virtual table
  - Enriched text assembled from user prompts + high-value observations + session summary (~200-500 tokens)
  - Provides much higher semantic signal than per-observation embeddings
  - `context_semantic_search` defaults to session scope with observation fallback
- Embeddings generated on-demand via `context_embed` MCP tool (NOT at capture time — avoids hook latency)
- Background embedding runs automatically on MCP server startup for new observations and sessions
- First-time setup: run `context_embed` once to auto-install dependencies and bootstrap
- `@huggingface/transformers` is an optional dependency — all other features work without it
- Model: `Xenova/all-MiniLM-L6-v2` (~80MB, cached to `~/.cache/huggingface/`)

### 9. Rule-Based Compaction
- Old observations (>7 days) compressed into summaries during vacuum
- Groups by session + tool, only compact groups of 3+
- Never compacts high-importance observations
- Format: `"Read x4: file1.ts, file2.ts, ..."` (~15 tokens vs ~80)
- Vector rows in `vec_observations` are deleted before their source observation rows are deleted. Orphaned vector entries would otherwise accumulate silently across compaction cycles and never be cleaned up.

### 10. Surprise Scoring (v0.7.0)
- File encounter frequency tracked in `file_encounter_counts` table (per file + project + tool)
- At capture time, importance_score is adjusted based on novelty:
  - First encounter: +0.15, encounters 2-3: +0.05, 11+: -0.10
  - Total cap: [-0.15, +0.20] to prevent dominating base score
- Uses **7-day windowed count** from observations for scoring (not lifetime counter)
  - Files untouched for a week feel novel again
  - Lifetime counter still maintained in `file_encounter_counts` for analytics
- Novel files surface above routine reads of the same files

### 11. Observation Relationships (v0.7.0)
- `observation_relationships` table links observations passively at capture time
- Two relationship types inferred automatically:
  - `followed_by` — sequential observations in the same session
  - `same_file` — observations touching the same file (within 24h, same project)
- `ON DELETE CASCADE` ensures cleanup during compaction/vacuum
- `getRelatedObservations()` enables bidirectional graph traversal
- `context_search` enriches top results with related observations

### 12. Retrieval Routing (v0.7.0)
- `context_search` auto-classifies queries and picks the optimal search strategy:
  - **keyword** (1-2 words, file names, identifiers) → FTS5 only (fast path)
  - **semantic** (5+ words, natural language questions) → vector search (sessions then observations)
  - **hybrid** (3-4 words, mixed) → both FTS5 + vector, merged with Reciprocal Rank Fusion (k=60)
- Graceful degradation: if embeddings unavailable, all strategies fall back to keyword
- Search method included in output for transparency

### 13. Session Narrative Selection (v0.8.3)
- The Stop hook previously used the **last** assistant message as the session summary — often a closing remark ("Yes.", "Now bump the version...")
- Now scores all assistant messages for narrative quality and picks the best candidate
- Scorer (`scoreForNarrative`) favors messages that describe work done:
  - Action verbs: implement, add, fix, update, create, refactor, replace, rewrite (+0.20)
  - File path references like `processor.ts`, `sqlite.ts` (+0.15)
  - Code blocks (+0.10), bullet lists (+0.10), longer messages (+0.15/+0.10)
  - Short affirmations ("Yes", "Sure", "Ok", "Let me...") score 0 even if they pass length check
- Best-scoring message used if score >= 0.25; falls back to last assistant message otherwise
- Result: session narratives in `context_list` now reflect what was accomplished, not how the session closed

### 14. Domain Tag Inference (v0.8.6)
- Every observation gets domain tags inferred at capture time from file paths and Bash commands
- Tags stored as comma-separated string in `tags TEXT` column (added via migration, NULL for old observations)
- 10 tag categories: `auth`, `database`, `testing`, `infra`, `config`, `frontend`, `api`, `git`, `build`, `deps`
- Inference rules: file path pattern matching (e.g., `/auth/`, `sqlite`, `.test.`) + Bash command patterns (e.g., `git commit` → `git`, `npm run build` → `build`)
- Multiple tags per observation are normal (e.g., a test migration file gets both `database` and `testing`)
- `context_search` supports `tag:X` prefix to route directly to tag-filtered search, bypassing FTS5/vector routing
- `tag:X keyword` syntax further filters tag results by FTS5 keyword (intersection)
- Tags visible in `context_search` output as `[auth, config]` suffix on each observation line
- Partial index on `tags WHERE tags IS NOT NULL` keeps tag queries fast without scanning NULL rows
- **Tag matching uses delimiter-anchored LIKE** (`',' || tags || ','` matched against `%,tag,%`): prevents substring collisions where e.g. `api` would incorrectly match `api_key`, and correctly matches tags in all positions including first and last

### 15. Security and Input Validation (Sprint 1 P0)

**Hook input path validation:**
- `validateStopInput`: `transcript_path` is resolved with `realpathSync` (symlink-safe) and must remain within `~/.claude/projects/` before use. Paths that resolve outside this boundary are silently dropped rather than used. This prevents directory traversal via crafted or symlinked paths.
- `validateSessionStartInput`: when path validation fails, the fallback is `process.cwd()` then `homedir()`. Raw untrusted input is never used as the fallback, which would cause over-broad database scoping (a parent-directory path would expose unrelated project contexts).

**Debug log discipline:**
- `capture-prompt.ts` and `session-end.ts` no longer write raw prompt content or raw stdin to debug logs. Only metadata is logged (session ID, content length, key names). This prevents sensitive prompt content from appearing in log files.

**Storage correctness fixes:**
- `searchPrompts` uses `ftsQuery` (the FTS5-escaped form) in the `ELSE` branch, not the raw query string. Queries containing dots, hyphens, or FTS5 boolean operators no longer cause parse errors.
- `getWithinBudget` has a `LIMIT 500` and orders by `importance_score DESC, created_at DESC`. Without the limit, context injection could grow unbounded on mature databases with thousands of observations.
- `compactObservations` deletes rows from `vec_observations` before deleting the source observation rows. Without this, compaction leaves orphaned vector rows that accumulate and are never cleaned up.
- `session-end.ts` error path uses `await writeResponse({ status: 'error' })` (async, consistent with all other exit paths) instead of synchronous `process.stdout.write`. The sync write could fail to flush before the process exited.

---

## Data Storage

All data stored in `~/.claude-context/`:

```
~/.claude-context/
+-- context.db          # SQLite database
+-- logs/               # Debug logs (optional)
```

---

## Hook Response Formats

### SessionStart
```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "markdown context string"
  }
}
```

### PostToolUse
```json
{
  "status": "captured" | "skipped" | "error"
}
```

### Stop
```json
{
  "status": "complete" | "error"
}
```

---

## Development Commands

```bash
# Install dependencies
npm install

# Build all components (src, hooks, CLI, web)
npm run build

# Type check only
npm run typecheck

# Clean build artifacts
npm run clean

# Build and prepare plugin for installation
npm run build:plugin

# Uninstall plugin (keep data)
npm run plugin:uninstall

# Uninstall plugin (remove data)
npm run plugin:uninstall:all

# Run CLI
npm run cli -- stats
npm run cli -- list --limit 10
npm run cli -- search "query"
npm run cli -- export --dry-run

# Import historical transcripts
npm run import -- --source <path> --project <target> [--filter <text>] [--dry-run]

# Web dashboard
npm run web        # Start server at http://localhost:3847
npm run web:dev    # Development mode with live reload
```

---

## Configuration

Environment variables (optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_DB` | `~/.claude-context/context.db` | Database path |
| `CONTEXT_MANAGER_TOKEN_BUDGET` | `4000` | Max tokens for context injection |
| `CONTEXT_MANAGER_PORT` | `3847` | Web dashboard port |
| `CONTEXT_MANAGER_HOST` | `localhost` | Web dashboard host |
| `CONTEXT_SEARCH_MIN_SCORE` | `0.25` | Minimum cosine similarity for semantic/hybrid search results; FTS5 results are never filtered |

---

## Privacy

The `<private>` tag excludes content from storage:

```xml
<private>
API_KEY=sk-abc123...
</private>
```

Content within `<private>` tags is replaced with `[REDACTED]` before storage.

**Hardened behaviors (Sprint 1 P0):**
- **Unclosed `<private>` tag**: if the closing `</private>` is absent, all remaining content after the opening tag is redacted rather than stored verbatim. This closes the partial-tag leak vector.
- **Edit/Write field stripping**: `old_string`, `new_string`, and `content` fields are removed from Edit/Write `tool_input` metadata before storage. These fields can contain diff content with secrets that would otherwise bypass `SENSITIVE_PATTERNS` matching. The observation still captures the file path and operation type.

---

## Hooks Registered

The plugin uses the Claude Code marketplace plugin system to register hooks.

| Hook | Purpose | Timeout | Matcher |
|------|---------|---------|---------|
| `SessionStart` | Create session, inject status hint | 10s | `startup\|clear\|compact` |
| `UserPromptSubmit` | Capture user prompts | 5s | - |
| `PostToolUse` | Capture tool interactions | 5s | `*` |
| `Stop` | Save summary, extract conversation insights, export to auto-memory | 10s | - |
| `PreCompact` | Save session before /compact | 10s | - |

**Installation mechanism:**
- Hook definitions: `plugin/hooks/hooks.json`
- Built scripts: `plugin/scripts/` (generated by build process)
- Plugin metadata: `plugin/.claude-plugin/plugin.json`
- Marketplace metadata: `.claude-plugin/marketplace.json`

When installed via `/plugin install context-manager`, Claude Code:
1. Copies the plugin to `~/.claude/plugins/`
2. Registers hooks defined in `hooks.json`
3. Resolves `${CLAUDE_PLUGIN_ROOT}` to the installed plugin directory
4. Executes hook scripts on the appropriate events

---

## Related Projects

- **claude-mem** (thedotmack): Full-featured memory plugin with Agent SDK, ChromaDB, viewer UI
- Reference implementation for hook response formats and native module handling

---

## Troubleshooting

### Native module errors
```bash
# Rebuild native modules
npm rebuild better-sqlite3
```

### Check if plugin is installed
```bash
# In Claude Code
/plugin list

# Or check the installed plugins
cat ~/.claude/plugins/installed_plugins.json | jq '.plugins["context-manager@mrlesmithjr"]'
```

### Test hooks manually
```bash
echo '{"cwd":"'$(pwd)'"}' | node ~/.claude/plugins/cache/mrlesmithjr/context-manager/*/scripts/context-inject.js
```

### Check database stats
Use the `context_stats` MCP tool in Claude Code or run the CLI directly from the project directory.

### Updates not applying (IMPORTANT)

The plugin system caches by version number. If you modify code but don't bump the version, updates won't apply.

**For local development:**
1. Bump version: `npm version patch --no-git-tag-version`
2. Rebuild: `npm run build:plugin`
3. Update in Claude Code: `/plugin update context-manager`
4. Restart Claude Code

**If update still doesn't apply:**
```
/plugin uninstall context-manager
/plugin install context-manager
```
Then restart Claude Code.

**From GitHub:** Updates should work automatically since each push has a new commit SHA.
