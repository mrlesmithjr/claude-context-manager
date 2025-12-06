# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

**Status**: ACTIVE
**Last Updated**: December 6, 2025

---

## Project Overview

**claude-context-manager** is a Claude Code plugin that provides persistent memory across sessions. It automatically captures tool interactions, stores them in SQLite with full-text search, and injects relevant context at the start of each session.

**Owner**: Larry Smith Jr.
**Email**: mrlesmithjr@gmail.com
**Directory**: `~/Projects/Personal/claude-context-manager`

---

## Quick Reference

```bash
# Build and install
npm run plugin:install

# Uninstall (keep data)
npm run plugin:uninstall

# Uninstall (remove all data)
npm run plugin:uninstall:all
```

### Slash Commands (in Claude Code)
- `/ctx-stats` - Show statistics
- `/ctx-list` - List recent observations
- `/ctx-search <query>` - Search observations
- `/ctx-vacuum [days]` - Clean up old data

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
+-- cli/
|   +-- index.ts               # CLI entry point
+-- plugin/
|   +-- hooks.json             # Hook definitions (reference only)
|   +-- hooks/
|       +-- context-inject.ts  # SessionStart: inject past context
|       +-- capture-tool.ts    # PostToolUse: capture interactions
|       +-- session-end.ts     # Stop: save summary
+-- scripts/
|   +-- install.js             # Installation script
|   +-- uninstall.js           # Uninstallation script
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
+-- docs/
|   +-- ARCHITECTURE.md        # Detailed architecture
|   +-- IMPLEMENTATION_PLAN.md # Original implementation plan
+-- dist/                      # Built output (gitignored)
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

### 2. Per-Project Scoping
- Observations are scoped by `project` (derived from `cwd`)
- Context injection only retrieves observations from current project
- Clean separation across projects

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

# Build TypeScript
npm run build

# Type check only
npm run typecheck

# Clean build artifacts
npm run clean

# Install plugin (builds first)
npm run plugin:install

# Uninstall plugin (keep data)
npm run plugin:uninstall

# Uninstall plugin (remove data)
npm run plugin:uninstall:all

# Run CLI
npm run cli -- stats
npm run cli -- list --limit 10
npm run cli -- search "query"
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

The install script adds these hooks directly to `~/.claude/settings.json`:

| Hook | Purpose | Timeout |
|------|---------|---------|
| `SessionStart` | Inject context at session start | 5000ms |
| `UserPromptSubmit` | Capture user prompts | 1000ms |
| `PostToolUse` | Capture tool interactions | 1000ms |
| `Stop` | Save session summary | 5000ms |

NOTE: Hooks are added directly to settings.json (not via plugin marketplace) because SessionStart hooks don't fire reliably through the marketplace plugin system.

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

### Check if hooks are registered
```bash
cat ~/.claude/settings.json | grep context-manager
```

### Test hooks manually
```bash
echo '{"cwd":"'$(pwd)'"}' | node dist/hooks/context-inject.js
```

### Check database stats
Use `/ctx-stats` in Claude Code or run the CLI directly from the project directory.
