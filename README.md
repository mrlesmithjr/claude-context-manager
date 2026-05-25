# claude-context-manager

A Claude Code plugin that automatically captures every tool interaction in SQLite, scores and tags observations by importance, exports high-value context to Claude Code's auto-memory, and provides keyword, semantic, and tag-based search across your session history.

---

## Install

**In Claude Code:**

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

Restart Claude Code to activate.

---

## Quick Start

After installing and restarting:

1. Work normally. The plugin captures tool interactions in the background.
2. At session end, high-importance observations are exported to auto-memory automatically.
3. Use MCP tools to search or review what was captured:

```
context_stats          # overview of current project
context_list           # recent sessions with summaries
context_search "auth"  # keyword search
context_search "tag:database sqlite"  # tag-filtered search
```

To enable semantic (vector) search, run `context_embed` once. It auto-installs dependencies (~265 MB) and bootstraps embeddings for existing sessions.

---

## Features

| Feature | Description |
|---------|-------------|
| Automatic capture | PostToolUse hook records every tool interaction |
| Importance scoring | Each observation scored 0.0-1.0; high/medium/low classification |
| Surprise scoring | First-time file encounters boosted; frequently-seen files decayed |
| Domain tag inference | Auto-tags with `auth`, `database`, `testing`, `infra`, `config`, `frontend`, `api`, `git`, `build`, `deps` |
| Retrieval routing | Short queries use FTS5; natural language uses vectors; mixed uses Reciprocal Rank Fusion |
| Tag search | `tag:X` prefix in `context_search` routes directly to tag-filtered results |
| Session summaries | Stop hook selects the best-scoring assistant message as the session narrative |
| Conversation insights | High-signal assistant responses (tables, decisions, comparisons) extracted and stored |
| Auto-memory export | Observations scoring >= 0.65 exported to `context-manager-activity.md` at session end |
| Semantic search | Session-level vector embeddings via sqlite-vec; enriched text from prompts and actions |
| Auto-compaction | Old observations compressed into summaries during vacuum (`Read x4: file1, file2, ...`) |
| Observation relationships | Observations linked by shared file (`same_file`), sequence (`followed_by`), and cross-project shared file (`cross_project_same_file`); `context_search` shows cross-project results in a separate section when they exist |
| Hierarchical visibility | Parent directories see all child project contexts via prefix matching |
| Memory audit | Detect orphaned memory directories when launch points change |
| Memory consolidation | Migrate orphaned memories to parent with dedup and index rebuild |
| Transcript import | Import historical sessions from Claude Code backups |
| Web dashboard | Browse sessions, search observations, view analytics at `http://localhost:3847` |
| PreCompact hook | Saves session state before `/compact` so context survives compaction |
| File-context injection | Before each Read, injects a compact history of prior work on that file (first read per file per session only) |
| Privacy tags | `<private>` tag excludes content from storage |
| Local storage | All data stays on your machine; no external APIs required |

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_DB` | `~/.claude-context/context.db` | Database path |
| `CONTEXT_MANAGER_TOKEN_BUDGET` | `4000` | Max tokens injected at session start |
| `CONTEXT_MANAGER_PORT` | `3847` | Web dashboard port |
| `CONTEXT_MANAGER_HOST` | `localhost` | Web dashboard host |
| `CONTEXT_SEARCH_MIN_SCORE` | `0.25` | Minimum cosine similarity for semantic and hybrid search results; FTS5 results are never filtered |
| `CONTEXT_MANAGER_URL` | _(unset)_ | When set, hooks POST captures to this URL instead of local SQLite (proxy mode). All hooks and the stdio MCP server read this from `~/.claude-context/.env` automatically; no shell export needed. |
| `CONTEXT_MANAGER_TOKEN` | _(unset)_ | Bearer token for the HTTP server and proxy mode; required when `CONTEXT_MANAGER_URL` is set |
| `CONTEXT_MANAGER_CHECKPOINT_INTERVAL` | `30` | Minutes between periodic checkpoint exports during a live session |
| `CONTEXT_MANAGER_EMBED_INTERVAL` | `10` | Minutes between background embedding passes in HTTP server mode; invalid values fall back to 10 |

Place variables in `~/.claude-context/.env`. All hooks and the stdio MCP server load this file at startup. No shell configuration, `.zshrc` exports, or launchctl overrides are needed.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `context_add` | Write a manual observation from any MCP client (Claude Desktop, etc.). Accepts `text` (required), `project`, `importance` ("high", "medium", "low", or float 0–1), and `tags` (comma-separated). |
| `context_stats` | Show statistics for the current project |
| `context_list` | List recent sessions with summaries |
| `context_search` | Search observations and prompts. Auto-routes to FTS5, vector, or hybrid. Supports `tag:X` prefix and `tag:X keyword` for intersection. |
| `context_semantic_search` | Search sessions by meaning using enriched vector embeddings |
| `context_embed` | Generate vector embeddings. First run installs dependencies and bootstraps all sessions. |
| `context_vacuum` | Delete observations older than N days and run compaction. Stale session cleanup (sessions with no Stop hook) now runs automatically on every session open — `context_vacuum` is no longer needed for that purpose. Optional `stale_session_hours` (default: 2) is still accepted for on-demand cleanup. |
| `context_prune` | Targeted pruning by tool name, importance, and/or age. Always use `dry_run=true` first. |
| `context_export` | Trigger auto-memory export manually |
| `context_memory_audit` | Scan for orphaned memory directories |
| `context_memory_consolidate` | Migrate orphaned memories to parent project (dry-run by default) |

---

## Deployment

> New to context-manager or setting up on a new machine? See the [Setup Guide](docs/SETUP.md) for a step-by-step walkthrough of all three deployment modes.

### Default: local SQLite (single machine)

No server setup required. Hooks write directly to `~/.claude-context/context.db`. This is the default after plugin install.

### HTTP server + proxy mode (multi-machine)

Run a central server so multiple machines share one database. Hooks become thin HTTP clients when `CONTEXT_MANAGER_URL` is set.

**macOS (recommended: launchd for reboot persistence)**

```bash
make server-quickstart
```

This one command generates a bearer token, writes `~/.claude-context/.env`, and installs the server as a launchd agent that starts automatically on login. Then restart Claude Code. Hooks read `.env` automatically, no shell configuration needed.

**Linux / Docker**

```bash
make server-init && make server-start
```

This starts two services: the MCP capture server on port 4000 and the web dashboard on port 3847. The web UI includes an Import tab for uploading a `context.db` file to migrate from local SQLite. Then restart Claude Code.

**Verify**

```bash
curl -s http://localhost:4000/health
make server-native-status   # macOS
```

**Server management commands:**

| Command | Purpose |
|---------|---------|
| `make server-quickstart` | macOS: init token, install launchd agent, start server (all-in-one) |
| `make server-init` | Generate token and write `~/.claude-context/.env` (idempotent) |
| `make server-env` | Print remote mode environment summary |
| `make server-native-start` | Start server natively in background |
| `make server-native-stop` | Stop native background server |
| `make server-native-status` | Health check for native server |
| `make server-launchd-install` | Install as launchd agent (macOS persistent startup) |
| `make server-launchd-uninstall` | Remove launchd agent |
| `make server-launchd-status` | Check launchd agent status |
| `make server-start` | Start both Docker services: MCP server (port 4000) and web UI (port 3847); pre-flight check exits with an actionable error if ports are occupied by the native launchd service |
| `make server-stop` | Stop Docker server |
| `make server-logs` | Tail Docker server logs |
| `make server-status` | Health check; warns if both native and Docker services are running simultaneously |
| `make server-stop-native` | Unload launchd service without removing the plist (plist preserved for future `make server-launchd-install`); falls back to server.pid kill for one-shot nohup processes |
| `make switch-to-docker` | Stop native launchd service, wait for ports to clear, then start Docker stack |
| `make switch-to-native` | Stop Docker stack, wait for ports to clear, then install launchd service |

**HTTP server endpoints** (all require Bearer auth except `/health`):

| Endpoint | Description |
|----------|-------------|
| `POST /capture/session` | Create or end a session |
| `POST /capture/observation` | Save one observation from a remote hook |
| `POST /capture/prompt` | Save one user prompt from a remote hook |
| `POST /capture/add` | Write a manual observation (forwarded from `context_add` in proxy mode) |
| `POST /capture/export` | Trigger server-side auto-memory export |
| `GET /memory?project=...` | Return current memory file content |
| `POST /mcp`, `GET /mcp` | StreamableHTTP MCP transport |
| `POST /api/import` | Import a `context.db` file into the active database (web server; multipart upload) |

Start the server directly:

```bash
CONTEXT_MANAGER_TOKEN=<secret> node dist/cli.js serve --port 4666
```

---

## Development

### Prerequisites

- Node.js 18+

### Build

```bash
npm install
npm run build            # Build all components (hooks, CLI, web)
npm run build:plugin     # Build and prepare plugin for local installation
npm run typecheck        # Type check only
npm run clean            # Remove build artifacts
```

### CLI

```bash
npm run cli -- stats
npm run cli -- list --limit 10
npm run cli -- search "query"
npm run cli -- export --dry-run
npm run cli -- vacuum --days 30
npm run cli -- vacuum --days 30 --stale-session-hours 2
```

### Web dashboard

```bash
npm run web        # Start at http://localhost:3847
npm run web:dev    # Development mode with live reload
```

### Import historical transcripts

```bash
npm run import -- \
  --source ~/.claude.backup/projects/-Users-you-OldProject \
  --project ~/Projects/NewProject \
  --filter "optional-keyword" \
  --dry-run
```

Remove `--dry-run` to actually import.

### E2E tests

E2E tests run in Docker and cover 5 scenarios with 36 assertions (basic queries, cross-project isolation, concurrent writes, stats, and remote capture).

```bash
make test-e2e        # Build, run all scenarios, tear down (CI-safe)
make test-e2e-up     # Start services for manual exploration
make test-e2e-down   # Stop and remove containers and ephemeral volume
make e2e-build       # Build E2E Docker image only
make e2e-clean       # Stop containers and remove Docker image
```

### Uninstall

```bash
# In Claude Code:
/plugin uninstall context-manager

# Keep data:
npm run plugin:uninstall

# Remove all data:
npm run plugin:uninstall:all
```

---

## Architecture

Hooks write directly to SQLite via `better-sqlite3`. No background service required in local mode.

```mermaid
flowchart LR
    subgraph hooks["Claude Code Hooks"]
        SI["SessionStart\nstatus hint ~30 tokens"]
        UP["UserPromptSubmit\ncapture prompt"]
        FC["PreToolUse\nfile history before Read"]
        PT["PostToolUse\nsummarize + score + tag"]
        SE["Stop\nnarrative + insights + export"]
        PC["PreCompact\nsave session before /compact"]
    end

    subgraph db["SQLite ~/.claude-context/context.db"]
        OBS["observations\nimportance · tags · embedding"]
        SES["sessions\nsummary · enriched_text · embedding"]
        UPT["user_prompts FTS5-indexed"]
    end

    subgraph out["Outputs"]
        MEM["Auto-Memory\ncontext-manager-activity.md"]
        MCP["MCP Tools\ncontext_search · context_list\ncontext_stats · context_embed\ncontext_vacuum · context_prune"]
        WEB["Web Dashboard\nlocalhost:3847"]
    end

    SI & UP & FC & PT & SE & PC --> db
    SE -->|"score >= 0.65"| MEM
    db --> MCP
    db --> WEB
```

For detailed design decisions, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Context visibility

Observations are scoped by project path. Parent directories see all child contexts via prefix matching:

| Working directory | Sees context from |
|-------------------|-------------------|
| `~/Projects/Work/ProjectA` | Only `ProjectA` |
| `~/Projects/Work` | All of `Work/*` |
| `~/Projects` | Everything |

### Hooks registered

| Hook | Purpose | Timeout |
|------|---------|---------|
| `SessionStart` | Create session, inject status hint, run stale session GC (local mode) | 10s |
| `UserPromptSubmit` | Capture user prompts, run periodic checkpoint export | 5s |
| `PreToolUse` | Inject compact file history before Read operations | 5s |
| `PostToolUse` | Capture tool interactions | 5s |
| `Stop` | Save summary, extract insights, export to auto-memory | 10s |
| `PreCompact` | Save session before `/compact` | 10s |

---

## Troubleshooting

### Plugin not working

Check whether the plugin is installed:

```bash
# In Claude Code:
/plugin list

# Or inspect the plugin registry:
cat ~/.claude/plugins/installed_plugins.json | jq '.plugins["context-manager@mrlesmithjr"]'
```

Test hooks manually:

```bash
echo '{"cwd":"'$(pwd)'"}' | \
  node ~/.claude/plugins/cache/mrlesmithjr/context-manager/*/scripts/context-inject.js
```

Check database stats with the `context_stats` MCP tool.

### Update not applying

The plugin caches by version number. For local development:

1. Bump version: `npm version patch --no-git-tag-version`
2. Rebuild: `npm run build:plugin`
3. In Claude Code: `/plugin update context-manager`
4. Restart Claude Code

If that still does not work:

```
/plugin uninstall context-manager
/plugin install context-manager
```

Then restart Claude Code.

### Native module errors

```bash
npm rebuild better-sqlite3
```

### Reset everything

```bash
npm run plugin:uninstall:all
npm run build:plugin
```

---

## Privacy

Wrap sensitive content in `<private>` tags to exclude it from storage:

```xml
<private>
DATABASE_URL=postgres://secret:password@host/db
API_KEY=sk-live-xxxxx
</private>
```

Content within `<private>` tags is replaced with `[REDACTED]` before storage. If the closing `</private>` tag is absent, all remaining content after the opening tag is redacted.

`old_string`, `new_string`, and `content` fields from Edit and Write tool inputs are stripped before storage. The observation retains the file path and operation type but not the diff content.

All data is stored locally in `~/.claude-context/`. No data leaves your machine.

---

## License

MIT

## Author

Larry Smith Jr. <mrlesmithjr@gmail.com>
