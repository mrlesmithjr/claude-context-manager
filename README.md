# claude-context-manager

Automatic session history and searchable context for Claude Code. Captures every tool interaction in SQLite with full-text search and a web dashboard.

**Status**: ACTIVE
**Last Updated**: March 4, 2026

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

---

## How It Works

```
During your session:
+-----------------------------------------+
| Every tool interaction is captured:     |
|  - Files read/written                   |
|  - Commands run                         |
|  - Edits made                           |
|  - Session summary saved on exit        |
+-----------------------------------------+
                    |
                    v (stored in SQLite)

Later:
+-----------------------------------------+
| Search: "authentication"                |
| Browse: last week's sessions            |
| Dashboard: token usage analytics        |
| Context: auto-injected at session start |
+-----------------------------------------+
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Automatic Capture** | PostToolUse hook captures every tool interaction |
| **Full-Text Search** | SQLite FTS5 enables fast keyword search |
| **Web Dashboard** | Browse sessions, search observations, view analytics |
| **Hierarchical Visibility** | Parent directories see child project contexts |
| **Token Budget** | Configurable limit on injected context size |
| **Privacy Tags** | `<private>` tag excludes sensitive content |
| **Local Storage** | All data stays on your machine - no external APIs |
| **Session Summaries** | Stop hook captures session summaries |
| **Transcript Import** | Import historical sessions from backups |

---

## Architecture

```
Claude Code Hooks                    Storage
-----------------                    -------
SessionStart ----------------------> SQLite + FTS5
  (inject context)                   ~/.claude-context/context.db

PostToolUse ----------------------->
  (capture tools)

Stop ------------------------------->
  (save summary)
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
# Clean up slash commands and data directory (keep data)
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

1. **Session Start**: Previous context is injected (you'll see a message like `[context-manager] Injected X observations...`)
2. **During Session**: Tool interactions are captured in the background
3. **Session End**: Session summary is saved

### Slash Commands

Once installed, use these commands in Claude Code:

| Command | Description |
|---------|-------------|
| `/ctx-stats` | Show statistics for current project |
| `/ctx-list` | List recent observations |
| `/ctx-search <query>` | Search observations |
| `/ctx-vacuum [days]` | Clean up old data |
| `/ctx-web` | Start the web dashboard |

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
| `SessionStart` | Inject context at session start | 10s | `startup\|clear\|compact` |
| `UserPromptSubmit` | Capture user prompts | 5s | - |
| `PostToolUse` | Capture tool interactions | 5s | `*` |
| `Stop` | Save session summary | 10s | - |

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

4. Use `/ctx-stats` in Claude Code to check statistics

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

Claude Code's built-in memory (`CLAUDE.md` and auto-memory files) handles **curated knowledge** - conventions, architecture decisions, and preferences that Claude deliberately saves.

This plugin handles **automatic history** - a complete, searchable record of what happened across sessions. They work well together:

| | Built-in Memory | This Plugin |
|---|---|---|
| **What it stores** | Curated patterns and conventions | Every tool interaction automatically |
| **How it's saved** | Claude decides what to write | Automatic - nothing falls through |
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
| **Storage** | SQLite + FTS5 | SQLite + ChromaDB vectors |
| **Search** | Full-text keyword | Semantic + keyword |
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
- Semantic search (find conceptually related context, not just keywords)
- AI-powered summarization
- MCP tool integration
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
