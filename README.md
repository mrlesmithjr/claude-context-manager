# claude-context-manager

Persistent memory for Claude Code sessions. Automatically captures context and injects it into future sessions.

**Status**: ACTIVE
**Last Updated**: December 5, 2025

---

## The Problem

Claude Code sessions are stateless. Every new session starts fresh with no memory of:

- What you worked on yesterday
- Decisions you made and why
- Your project's architecture and patterns
- Ongoing tasks and their current state

You end up repeating yourself constantly:
> "Remember, we're using the repository pattern..."
> "As I mentioned before, the auth flow works like..."
> "We decided last week to use Redis because..."

---

## The Solution

**claude-context-manager** automatically:

1. **Captures** every tool interaction during your session
2. **Stores** observations in a local SQLite database with full-text search
3. **Injects** relevant context at the start of each new session

No manual intervention required. Context persists across sessions automatically.

---

## How It Works

```
Session 1:
+-----------------------------------------+
| You: "Let's implement JWT auth"         |
| Claude: [reads files, writes code]      |
|                                         |
| -> Captured: files read, decisions made,|
|    patterns used, code written          |
+-----------------------------------------+
                    |
                    v (stored in SQLite)

Session 2 (days later):
+-----------------------------------------+
| [Context auto-injected]                 |
| "Previous work in this project:         |
|  - Implemented JWT auth in src/auth/    |
|  - Using bcrypt for password hashing    |
|  - Middleware pattern in src/middleware |
|  ..."                                   |
|                                         |
| You: "Add password reset"               |
| Claude: [Already knows the auth setup!] |
+-----------------------------------------+
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Automatic Capture** | PostToolUse hook captures every tool interaction |
| **Per-Project Scoping** | Memories are isolated by project directory |
| **Full-Text Search** | SQLite FTS5 enables fast keyword search |
| **Token Budget** | Configurable limit on injected context size |
| **Privacy Tags** | `<private>` tag excludes sensitive content |
| **Local Storage** | All data stays on your machine |
| **Session Summaries** | Stop hook captures session summaries |

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

## Installation

### Prerequisites

- Node.js 18+
- Claude Code

### Install

```bash
# Clone the repository
git clone https://github.com/mrlesmithjr/claude-context-manager.git
cd claude-context-manager

# Install dependencies
npm install

# Build and install the plugin
npm run plugin:install
```

The install script will:
1. Build the TypeScript source
2. Copy plugin files to `~/.claude/plugins/context-manager/`
3. Add hooks to `~/.claude/settings.json`
4. Create data directory at `~/.claude-context/`

**Restart Claude Code** to activate the plugin.

### Uninstall

```bash
# Uninstall (keep your data)
npm run plugin:uninstall

# Uninstall and remove all data
npm run plugin:uninstall:all
```

---

## Usage

### Automatic Operation

Once installed, the plugin works automatically:

1. **Session Start**: Previous context is injected (you'll see a message like `[context-manager] Injected X observations...`)
2. **During Session**: Tool interactions are captured in the background
3. **Session End**: Session summary is saved

### CLI Commands

```bash
# Check statistics
node ~/.claude/plugins/context-manager/dist/cli.js stats

# List recent observations
node ~/.claude/plugins/context-manager/dist/cli.js list --limit 20

# Search observations
node ~/.claude/plugins/context-manager/dist/cli.js search "authentication"

# Search in specific project
node ~/.claude/plugins/context-manager/dist/cli.js search "API" --project ~/Projects/my-app

# Clean up old data
node ~/.claude/plugins/context-manager/dist/cli.js vacuum --days 30
```

### CLI Alias (Optional)

Add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
alias ctx="node ~/.claude/plugins/context-manager/dist/cli.js"
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

The plugin registers three hooks in `~/.claude/settings.json`:

| Hook | Purpose | Timeout |
|------|---------|---------|
| `SessionStart` | Inject context at session start | 5s |
| `PostToolUse` | Capture tool interactions | 1s |
| `Stop` | Save session summary | 5s |

---

## Troubleshooting

### Plugin not working?

1. Check if hooks are in settings.json:
   ```bash
   cat ~/.claude/settings.json | grep context-manager
   ```

2. Test hooks manually:
   ```bash
   echo '{"session_id":"test","cwd":"'$(pwd)'"}' | \
     node ~/.claude/plugins/context-manager/dist/hooks/context-inject.js
   ```

3. Check stats:
   ```bash
   node ~/.claude/plugins/context-manager/dist/cli.js stats
   ```

### Native module errors?

If you see `ERR_MODULE_NOT_FOUND` for `better-sqlite3`:

```bash
# Reinstall the plugin (recreates symlinks)
npm run plugin:install
```

### Need to reset?

```bash
# Remove all data and reinstall
npm run plugin:uninstall:all
npm run plugin:install
```

---

## Comparison with claude-mem

| Aspect | claude-mem | claude-context-manager |
|--------|------------|------------------------|
| Lines of code | ~51,500 | ~2,500 |
| AI extraction | Claude Agent SDK | Simple heuristics |
| Vector search | ChromaDB | None (FTS5 only) |
| Viewer UI | React web app | CLI only |
| Dependencies | PM2, Chroma, SDK | SQLite only |
| Architecture | HTTP service | Direct SQLite |
| Complexity | Production-grade | Personal tool |

This project prioritizes simplicity over features. If you need the full feature set, use [claude-mem](https://github.com/thedotmack/claude-mem).

---

## Development

```bash
# Build
npm run build

# Type check
npm run typecheck

# Clean build artifacts
npm run clean

# Install plugin (builds first)
npm run plugin:install

# Uninstall plugin
npm run plugin:uninstall
```

---

## License

MIT

---

## Author

Larry Smith Jr. <mrlesmithjr@gmail.com>
