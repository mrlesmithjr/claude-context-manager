# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

**Status**: ACTIVE
**Last Updated**: December 13, 2025

---

## Project Overview

**claude-context-manager** is a Claude Code plugin that provides persistent memory across sessions. It automatically captures tool interactions, stores them in SQLite with full-text search, and injects relevant context at the start of each session.

**Owner**: Larry Smith Jr.
**Email**: mrlesmithjr@gmail.com
**Directory**: `~/Projects/Personal/claude-context-manager`

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

### Slash Commands (in Claude Code)
- `/ctx-stats` - Show statistics
- `/ctx-list` - List recent observations
- `/ctx-search <query>` - Search observations
- `/ctx-vacuum [days]` - Clean up old data

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
|  SessionStart Hook    ->  Inject relevant past context       |
|  PostToolUse Hook     ->  Capture tool interactions          |
|  Stop Hook            ->  Save session summary               |
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
| Database | SQLite + FTS5 | Local-only, fast FTS, no dependencies |
| Build | esbuild | Fast bundling, ESM output |
| Native Module | better-sqlite3 | Synchronous SQLite access |

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
|   +-- install.js             # Prep script (dirs, slash commands)
|   +-- uninstall.js           # Cleanup script
|   +-- import-transcripts.ts  # Import historical transcripts from backups
+-- src/
|   +-- capture/
|   |   +-- processor.ts       # Process tool outputs
|   +-- inject/
|   |   +-- builder.ts         # Build context for injection
|   +-- storage/
|   |   +-- interface.ts       # Storage interface definition
|   |   +-- sqlite.ts          # SQLite implementation
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
|   +-- IMPLEMENTATION_PLAN.md # Original implementation plan
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

### 5. Token-Aware Context Injection
- Track token estimates for stored observations
- Inject context within configurable budget (default: 4000 tokens)
- Most recent observations prioritized

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
| `SessionStart` | Inject context at session start | 10s | `startup\|clear\|compact` |
| `UserPromptSubmit` | Capture user prompts | 5s | - |
| `PostToolUse` | Capture tool interactions | 5s | `*` |
| `Stop` | Save session summary | 10s | - |

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
Use `/ctx-stats` in Claude Code or run the CLI directly from the project directory.

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
