# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

**Status**: ACTIVE
**Last Updated**: April 3, 2026

---

## Project Overview

**claude-context-manager** is a Claude Code plugin that provides structured session history and searchable context. It automatically captures tool interactions in SQLite with full-text search, and exports high-importance observations to Claude Code's auto-memory topic files.

**Owner**: Larry Smith Jr.
**Email**: mrlesmithjr@gmail.com
**Repository**: `github.com/mrlesmithjr/claude-context-manager`

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
- `context_search` - Search observations (FTS5 keyword)
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

```
+-------------------------------------------------------------+
|                    Claude Code Session                       |
+-------------------------------------------------------------+
|  SessionStart Hook    ->  Create session, minimal status hint |
|  PostToolUse Hook     ->  Capture tool interactions           |
|  Stop Hook            ->  Save summary + export to auto-memory|
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                    SQLite + FTS5                             |
|                    ~/.claude-context/context.db              |
+-------------------------------------------------------------+
|  observations         ->  Tool interactions                  |
|  sessions             ->  Session metadata + summaries       |
|  observations_fts     ->  Full-text search index             |
+-------------------------------------------------------------+
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

### 4. Simple Summarization
- Extract: tool name, files touched, basic patterns
- No AI extraction (unlike claude-mem)
- Trade-off: Less intelligent, but simpler and faster

### 5. Importance Scoring at Capture Time
- Every observation gets an importance level (high/medium/low) and numeric score (0.0-1.0)
- Base scores by tool type: Edit/Write (0.80), git commit (0.90), Read (0.30), Grep (0.25)
- Adjustments: errors (+0.25), config files (+0.15), test files (+0.10), lock files (-0.30)
- Scored at capture time (no post-hoc reprocessing needed)

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

---

## Privacy

The `<private>` tag excludes content from storage:

```xml
<private>
API_KEY=sk-abc123...
</private>
```

Content within `<private>` tags is replaced with `[REDACTED]` before storage.

---

## Hooks Registered

The plugin uses the Claude Code marketplace plugin system to register hooks.

| Hook | Purpose | Timeout | Matcher |
|------|---------|---------|---------|
| `SessionStart` | Create session, inject status hint | 10s | `startup\|clear\|compact` |
| `UserPromptSubmit` | Capture user prompts | 5s | - |
| `PostToolUse` | Capture tool interactions | 5s | `*` |
| `Stop` | Save summary + export to auto-memory | 10s | - |

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
