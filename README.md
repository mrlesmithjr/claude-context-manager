# claude-context-manager

Automatic session history and searchable context for Claude Code. Captures every tool interaction in SQLite with full-text search, exports high-value observations to Claude Code's auto-memory, and provides a web dashboard.

**Status**: ACTIVE
**Last Updated**: April 13, 2026

---

## What This Does

Claude Code has built-in memory (`CLAUDE.md` files and auto-memory) for persisting patterns and conventions. This plugin complements that by providing something built-in memory doesn't: **automatic, searchable session history**.

**Built-in memory** is great for curated knowledge - things Claude deliberately saves, like project conventions and architecture decisions.

**This plugin** automatically captures everything that happens during your sessions - every file read, edit, command run, and decision made - and stores it in a searchable database. Think of it as an activity log you can query later.

### What you get

- **"What did I do last week?"** - Browse sessions with summaries and timestamps
- **"Where did I use that pattern?"** - Full-text search across all captured interactions
- **"How much context am I generating?"** - Token analytics and usage dashboards
- **Cross-project visibility** - Parent directories see all child project activity

### Where this fits

Most teams already maintain curated knowledge — and they should. High-signal, domain-specific context lives in places like:

- **`CLAUDE.md` files** — project-level instructions Claude always sees
- **In-repo markdown** — architecture docs, protocol guides, component inventories, line indexes
- **Knowledge bases** — Obsidian vaults, Notion, Confluence, or similar tools for planning, tracking, and cross-project notes
- **Deliverable stores** — OneDrive, Google Drive, SharePoint for team-facing documents

A typical workflow might split knowledge across multiple locations by purpose — notes and planning in one place, code in another, deliverables in a third. That curated knowledge is high-signal and domain-specific. This plugin doesn't replace any of it.

Instead, this plugin covers the gap that manual curation can't: **everything you'd never bother writing down but wish you could search later**. Which files did you read while debugging that issue? What commands did you run last Thursday? What patterns emerged across sessions?

The best setup is both:

- **Manual curation** (CLAUDE.md, docs, knowledge bases) for domain knowledge, conventions, and architecture decisions
- **Auto-capture** (this plugin) for searchable session history, cross-project visibility, and the safety net that nothing falls through the cracks

This is "manual curation + auto-capture," not "auto-capture instead of manual curation."

---

## How It Works

```
During your session:
+-----------------------------------------+
| Tool interactions captured + scored:    |
|  - Files read/written                   |
|  - Commands run                         |
|  - Edits made (importance: high)        |
|  - Errors flagged (boosted +0.25)       |
|  - Surprise scoring (novel files +0.15) |
|  - Low-value tools filtered out         |
|  - User prompts indexed (FTS5)          |
|  - Relationships inferred automatically |
|    (same_file, followed_by)             |
+-----------------------------------------+
                    |
                    v (stored in SQLite with importance scores)

Session end:
+-----------------------------------------+
| Auto-memory export:                     |
|  - High-importance observations         |
|    (score >= 0.65) exported to          |
|    ~/.claude/projects/<path>/memory/    |
|    context-manager-activity.md          |
|  - Session summary saved                |
|  - Conversation insights extracted      |
|    (tables, recommendations, decisions) |
+-----------------------------------------+

Next session:
+-----------------------------------------+
| Minimal status hint (~30 tokens)        |
| Auto-memory provides the context        |
+-----------------------------------------+

Anytime:
+-----------------------------------------+
| Search: "authentication"                |
| Browse: last week's sessions            |
| Dashboard: token usage + importance     |
| Vacuum: auto-compacts old observations  |
+-----------------------------------------+
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Automatic Capture** | PostToolUse hook captures every tool interaction |
| **Smart Filtering** | Skips low-value tools (cat, ls, node_modules reads, broad globs) at capture time |
| **Importance Scoring** | Each observation scored 0.0-1.0 and classified as high/medium/low importance |
| **Surprise Scoring** | First-time file encounters boosted, frequently-seen files decayed — novel work surfaces above routine |
| **Domain Tag Inference** | Observations auto-tagged at capture time with domain categories (`auth`, `database`, `testing`, `infra`, `config`, `frontend`, `api`, `git`, `build`, `deps`) inferred from file paths and Bash commands — searchable via `tag:X` prefix in `context_search` |
| **Observation Relationships** | Observations automatically linked by shared files (`same_file`) and temporal sequence (`followed_by`) — search results enriched with related context |
| **Retrieval Routing** | Queries auto-classified as keyword/semantic/hybrid/tag — short terms use FTS5, natural language uses vectors, mixed queries merged with Reciprocal Rank Fusion, `tag:X` prefix routes to tag-filtered search |
| **Auto-Memory Export** | High-importance observations exported to Claude Code's auto-memory topic files at session end |
| **Auto-Compaction** | Old observations compressed into summaries during vacuum (`Read x4: file1, file2, ...`) |
| **Full-Text Search** | SQLite FTS5 across observations and user prompts |
| **Semantic Search** | Session-level vector embeddings (enriched with prompts, actions, outcomes) via sqlite-vec |
| **Web Dashboard** | Browse sessions, search observations, view analytics |
| **Hierarchical Visibility** | Parent directories see child project contexts |
| **Token Budget** | Configurable limit on injected context size with diversity caps |
| **Privacy Tags** | `<private>` tag excludes sensitive content |
| **Local Storage** | All data stays on your machine - no external APIs |
| **Session Summaries** | Stop hook captures session summaries |
| **Conversation Insights** | Stop hook extracts high-signal assistant responses (tables, recommendations, decisions) as searchable observations |
| **Transcript Import** | Import historical sessions from backups |
| **Memory Audit** | Detect orphaned memory directories when launch points change |
| **Memory Consolidation** | Migrate orphaned memories to parent with dedup and index rebuild |

---

## Architecture

```
Claude Code Hooks                    Storage               Auto-Memory
-----------------                    -------               -----------
SessionStart ----------------------> SQLite + FTS5
  (status hint)                      + sqlite-vec
                                     ~/.claude-context/
PostToolUse -----------------------> context.db
  (capture tools)

Stop ------------------------------>                ----> ~/.claude/projects/
  (save summary + conversation                             <path>/memory/
   insights + export)
                                                           context-manager-
MCP Tools:                                                 activity.md
  context_search -------> Auto-routed search:
                           tag:X (tag filter, fast path)
                           keyword (FTS5) | semantic (vectors)
                           | hybrid (RRF merge of both)
                           + related observations enrichment
  context_semantic_search -> Session vector search
                              (enriched: prompts+actions+summary)
  context_embed ---------> Generate embeddings
                             (observations + sessions)
```

Direct SQLite access - no background service required.

---

## Context Visibility

Context visibility uses **prefix matching** - parent directories see all child contexts:

| Working Directory | Sees Context From |
|-------------------|-------------------|
| `~/Projects/Work/ProjectA` | Only `~/Projects/Work/ProjectA/*` |
| `~/Projects/Work` | All of `~/Projects/Work/*` (ProjectA, ProjectB, etc.) |
| `~/Projects` | Everything under `~/Projects/*` |

**This means:**
- Working in a specific project → focused, relevant context
- Working in a parent directory → broader context across children
- Sibling projects are naturally isolated

**Practical example:**
```
# Import sessions to a specific project
npm run import -- --source ~/.backup/... --project ~/Projects/Work/ProjectA

# Context is now visible from:
#   ~/Projects/Work/ProjectA  ✓
#   ~/Projects/Work           ✓ (sees all Work children)
#   ~/Projects            ✓ (sees everything)
#
# But NOT from:
#   ~/Projects/Personal   ✗ (different branch)
```

---

## Installation

### Prerequisites

- Node.js 18+
- Claude Code

### Install from GitHub (Recommended)

The easiest way to install is directly from GitHub:

**In Claude Code:**

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

**Restart Claude Code** to activate the plugin.

### Install from Local Source

If you want to develop or modify the plugin:

```bash
# Clone the repository
git clone https://github.com/mrlesmithjr/claude-context-manager.git
cd claude-context-manager

# Install dependencies
npm install

# Build the plugin and prepare for installation
npm run build:plugin
```

**Then in Claude Code:**

```
/plugin marketplace add ~/path/to/claude-context-manager
/plugin install context-manager
```

**Restart Claude Code** to activate the plugin.

### Updating

```
/plugin update context-manager
```

Then restart Claude Code.

**Note:** If update doesn't work, try uninstall/reinstall:
```
/plugin uninstall context-manager
/plugin install context-manager
```

### Uninstall

**In Claude Code:**

```
/plugin uninstall context-manager
```

**Then optionally clean up:**

```bash
# Clean up legacy files and data directory (keep data)
npm run plugin:uninstall

# Clean up everything including all stored data
npm run plugin:uninstall:all
```

---

## Web UI Dashboard

Browse your context observations, sessions, and analytics through a local web interface.

### Starting the Dashboard

```bash
# From the project directory
cd /path/to/claude-context-manager
npm run web
```

The dashboard will be available at `http://localhost:3847`

### Features

- **Sessions View** - Browse all Claude Code sessions with summaries and timestamps
- **Search** - Full-text search across observations and user prompts
- **Analytics** - Token usage over time, activity timeline, tool distribution
- **Project Stats** - Per-project observation counts and activity

### Configuration

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_PORT` | `3847` | Web server port |
| `CONTEXT_MANAGER_HOST` | `localhost` | Web server host |

### Development Mode

For live reload during development:

```bash
npm run web:dev
```

---

## Usage

### Automatic Operation

Once installed, the plugin works automatically:

1. **Session Start**: A minimal status hint is injected (~30 tokens)
2. **During Session**: Tool interactions are captured and scored in the background
3. **Session End**: Best-scoring assistant message is selected as the session narrative (favors messages describing work done over closing remarks), high-importance observations are exported to auto-memory

### MCP Tools

Once installed, these tools are available to Claude Code via MCP:

| Tool | Description |
|------|-------------|
| `context_stats` | Show statistics for current project |
| `context_list` | List recent observations |
| `context_search` | Search observations and user prompts. Auto-routes: keyword (FTS5) for short queries, semantic (vectors) for natural language, hybrid (RRF) for mixed. Supports `tag:X` prefix to filter by domain — available tags: `auth`, `database`, `testing`, `infra`, `config`, `frontend`, `api`, `git`, `build`, `deps`. Example: `tag:auth`, `tag:database sqlite` |
| `context_semantic_search` | Search sessions by meaning (vector similarity, enriched text) |
| `context_embed` | Generate vector embeddings for observations and sessions |
| `context_vacuum` | Delete observations by age and run compaction/optimization |
| `context_prune` | Targeted pruning by tool name, importance, and/or age — use `dry_run=true` first |
| `context_export` | Export to auto-memory |
| `context_memory_audit` | Scan for orphaned memory directories when launch point changes |
| `context_memory_consolidate` | Migrate orphaned memories to parent project (dry-run by default) |

### CLI Commands

```bash
# Check statistics (use path where you cloned the repo)
node /path/to/claude-context-manager/dist/cli.js stats

# List recent observations
node /path/to/claude-context-manager/dist/cli.js list --limit 20

# Search observations
node /path/to/claude-context-manager/dist/cli.js search "authentication"

# Search in specific project
node /path/to/claude-context-manager/dist/cli.js search "API" --project ~/Projects/my-app

# Clean up old data
node /path/to/claude-context-manager/dist/cli.js vacuum --days 30

# Export to auto-memory (dry run)
node /path/to/claude-context-manager/dist/cli.js export --dry-run
```

### Import Historical Transcripts

Import session context from Claude Code backups:

```bash
cd /path/to/claude-context-manager

# Dry run first (see what would be imported)
npm run import -- \
  --source ~/.claude.backup/projects/-Users-you-Projects-OldProject \
  --project ~/Projects/NewProject \
  --filter "optional-keyword" \
  --dry-run

# Actual import
npm run import -- \
  --source ~/.claude.backup/projects/-Users-you-Projects-OldProject \
  --project ~/Projects/NewProject \
  --filter "optional-keyword"
```

**Use cases:**
- Migrating context when a project moves to a new directory
- Importing historical sessions from before the plugin was installed
- Filtering specific topic sessions (e.g., `--filter auth-service`)

### Semantic Search (Vector Embeddings)

Semantic search finds conceptually related sessions even when exact keywords don't match. It uses local vector embeddings — no external APIs required.

**How it works:**

At the end of each session, the plugin captures a session summary. In the background, the MCP server assembles **enriched text** for each session by combining:
- **User prompts** (what you asked — highest signal for intent)
- **High-value actions** (edits, writes, commits — not reads/greps)
- **Session summary** (the outcome)

This enriched text (~200-500 tokens per session) is then embedded using a local model and stored for similarity search. This means searching for "database migration fix" will find sessions where you worked on that topic, even if you never used those exact words.

**First-time setup:**

Run `context_embed` once to bootstrap — this auto-installs dependencies and generates embeddings for existing sessions:

```
# In Claude Code, use the MCP tool:
context_embed
```

The first run:
1. Auto-installs `@huggingface/transformers` + `onnxruntime-node` (~265MB one-time download)
2. Downloads the embedding model (`Xenova/all-MiniLM-L6-v2`, 384 dimensions, ~80MB, cached to `~/.cache/huggingface/`)
3. Embeds all existing observations and sessions

**After first-time setup, everything is automatic:**
- New observations and sessions are embedded in the background when the MCP server starts
- No manual `context_embed` calls needed for ongoing use
- `context_search` automatically falls back to semantic search when keyword search finds nothing

**Search by meaning:**
```
# In Claude Code:
context_semantic_search "authentication flow changes"

# Search sessions (default) or observations (legacy):
context_semantic_search "database fix" --scope sessions
context_semantic_search "database fix" --scope observations
```

**Key points:**
- FTS5 keyword search (`context_search`) always works independently — embeddings are optional
- All features work normally even if embedding setup hasn't been run
- All processing is local — no external APIs, no data leaves your machine

### Targeted Pruning

`context_vacuum` deletes all observations older than N days. `context_prune` lets you target specific noise — by tool name, importance level, and/or age — without touching unrelated observations.

**Always run `dry_run=true` first:**
```
# Preview: how many low-importance Bash observations older than 30 days would be deleted?
context_prune tool_name="Bash" importance="low" older_than_days=30 dry_run=true

# Same query, actually delete:
context_prune tool_name="Bash" importance="low" older_than_days=30
```

**Filter options (at least one required):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tool_name` | string | Tool to target: `"Bash"`, `"Read"`, `"Grep"`, etc. |
| `importance` | `"high"` \| `"medium"` \| `"low"` | Importance level to delete |
| `older_than_days` | number | Only delete observations older than N days |
| `dry_run` | boolean | Preview without deleting (default: `false`) |

**Notes:**
- At least one filter is required — calling with no filters returns 0 and does nothing.
- `dry_run=true` returns total count plus a sample of up to 5 matching observations.
- High-importance observations can be deleted by explicitly passing `importance="high"` — there is no guard beyond requiring a filter. Use `dry_run=true` to confirm before running.
- Vector embeddings (`vec_observations`) are cleaned up along with deleted observations. FTS5 and relationship edges cascade automatically.

### Memory Audit & Consolidation

When you change your launch directory (e.g., from `~/Obsidian/Personal/Finance/` to `~/Obsidian/Personal/`), Claude Code's memory files in `~/.claude/projects/` become orphaned — they're scoped to the old path and invisible from the new one. The context manager's observation database handles this automatically via prefix matching, but memory files need explicit migration.

**Audit orphaned memories:**
```
# In Claude Code, use the MCP tool:
context_memory_audit project="/Users/you/Obsidian/Personal"
```

This scans `~/.claude/projects/` for all directories matching the prefix and reports:
- Current project memory stats
- Orphaned child directories with file counts by type (user, feedback, project, reference)
- Recommendation for consolidation

**Consolidate memories (dry-run first):**
```
# Preview what would be migrated:
context_memory_consolidate project="/Users/you/Obsidian/Personal"

# Actually migrate:
context_memory_consolidate project="/Users/you/Obsidian/Personal" dry_run=false
```

Consolidation:
- Copies memory files from orphaned child directories to the parent
- Deduplicates by filename (skips files that already exist in parent)
- Skips `context-manager-activity.md` (observation DB handles this via prefix matching)
- Optionally skips stale project-type memories (>90 days, set `include_stale=true` to include)
- Rebuilds the parent `MEMORY.md` index grouped by type

### CLI Alias (Optional)

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
alias ctx="node /path/to/claude-context-manager/dist/cli.js"
```

Then use: `ctx stats`, `ctx list`, `ctx search "query"`

---

## Configuration

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_TOKEN_BUDGET` | `4000` | Max tokens to inject at session start |
| `CONTEXT_MANAGER_DB` | `~/.claude-context/context.db` | Database path |

---

## Privacy

### Private Tags

Wrap sensitive content in `<private>` tags to exclude from storage:

```xml
<private>
DATABASE_URL=postgres://secret:password@host/db
API_KEY=sk-live-xxxxx
</private>
```

### What Gets Stored

| Stored | NOT Stored |
|--------|------------|
| File paths | File contents (summarized only) |
| Tool names | Full tool outputs |
| Brief summaries | Content in `<private>` tags |
| Timestamps | Detected secrets (API keys, tokens) |

### Data Location

All data is stored locally in `~/.claude-context/`:
- `context.db` - SQLite database with observations and sessions
- `logs/` - Debug logs (if enabled)

---

## Hooks Registered

The plugin registers hooks via the Claude Code marketplace plugin system:

| Hook | Purpose | Timeout | Matcher |
|------|---------|---------|---------|
| `SessionStart` | Create session, inject status hint | 10s | `startup\|clear\|compact` |
| `UserPromptSubmit` | Capture user prompts | 5s | - |
| `PostToolUse` | Capture tool interactions | 5s | `*` |
| `Stop` | Save summary, extract conversation insights, export to auto-memory | 10s | - |

The Stop hook scans the transcript for high-signal assistant responses (markdown tables, recommendations, price comparisons, user fact confirmations) and saves them as `Conversation` observations. This ensures synthesized knowledge — not just tool invocations — is searchable in future sessions.

Hook definitions are in `plugin/hooks/hooks.json`. When you install the plugin via `/plugin install`, Claude Code automatically registers these hooks and executes the corresponding scripts in `plugin/scripts/`.

---

## Troubleshooting

### Plugin not working?

1. Check if plugin is installed:
   ```
   # In Claude Code
   /plugin list

   # Or check the installed plugins file
   cat ~/.claude/plugins/installed_plugins.json
   ```

2. Verify version is current:
   ```bash
   cat ~/.claude/plugins/installed_plugins.json | jq '.plugins["context-manager@mrlesmithjr"].version'
   ```

3. Test hooks manually:
   ```bash
   echo '{"cwd":"'$(pwd)'"}' | \
     node ~/.claude/plugins/cache/mrlesmithjr/context-manager/*/scripts/context-inject.js
   ```

4. Use the `context_stats` MCP tool in Claude Code to check statistics

### Updates not applying?

The plugin system caches by version. If you're developing locally:

1. **Bump the version** in `package.json` before rebuilding
2. Run `npm run build:plugin`
3. In Claude Code: `/plugin update context-manager`
4. Restart Claude Code

If that still doesn't work:
```
/plugin uninstall context-manager
/plugin install context-manager
```
Then restart Claude Code.

### Native module errors?

If you see `ERR_MODULE_NOT_FOUND` for `better-sqlite3`:

```bash
# Rebuild native modules
cd /path/to/claude-context-manager
npm rebuild better-sqlite3
```

### Need to reset?

```bash
# Remove all data and reinstall
npm run plugin:uninstall:all
npm run build:plugin
```

---

## How This Complements Built-in Memory

Claude Code's built-in memory (`MEMORY.md` and auto-memory topic files) handles **curated knowledge** - conventions, architecture decisions, and preferences that Claude deliberately saves.

This plugin captures **everything automatically** and exports the important parts to auto-memory. Since v0.4.0, it writes high-importance observations directly to a topic file (`context-manager-activity.md`) that Claude reads via auto-memory — no competing injection systems.

| | Built-in Memory | This Plugin |
|---|---|---|
| **What it stores** | Curated patterns and conventions | Every tool interaction automatically |
| **How it's saved** | Claude decides what to write | Automatic capture, high-value auto-exported |
| **Integration** | Native (MEMORY.md, topic files) | Exports to auto-memory topic files |
| **Searchable** | No (static files) | Yes (FTS5 full-text search) |
| **Browsable** | Read files manually | Web dashboard with analytics |
| **Session history** | No | Yes - timestamped session summaries |
| **Cross-project** | Per-project only | Hierarchical visibility |

---

## Why This Over claude-mem?

[claude-mem](https://github.com/thedotmack/claude-mem) is the most popular Claude Code memory plugin (~33K stars). It's feature-rich but comes with trade-offs. Choose based on what matters to you:

| | **claude-context-manager** | **claude-mem** |
|---|---|---|
| **License** | MIT | AGPL 3.0 |
| **Runtimes required** | Node.js | Node.js + Bun + Python |
| **External API calls** | None | Anthropic API (costs $) |
| **Background services** | None | Worker service on port 37777 |
| **Storage** | SQLite + FTS5 + sqlite-vec | SQLite + ChromaDB vectors |
| **Search** | Full-text keyword + semantic vectors | Semantic + keyword |
| **Summarization** | Deterministic heuristics | AI-powered (Agent SDK) |
| **Web UI** | Fastify dashboard | React viewer |
| **Lines of code** | ~2,500 | ~51,500+ |
| **Install complexity** | Plugin install, done | Plugin install + auto-installs Bun & uv |

**Choose this project if you want:**
- Zero external API costs or dependencies
- MIT license (AGPL can be problematic for commercial use)
- Nothing running in the background
- A single runtime (Node.js only)
- Predictable, deterministic behavior

**Choose claude-mem if you want:**
- AI-powered summarization (uses Anthropic API)
- AST-based code navigation

---

## Development

```bash
# Build
npm run build

# Type check
npm run typecheck

# Clean build artifacts
npm run clean

# Build and prepare plugin for installation
npm run build:plugin

# Uninstall plugin
npm run plugin:uninstall
```

---

## License

MIT

---

## Author

Larry Smith Jr. <mrlesmithjr@gmail.com>
