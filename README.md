# claude-context-manager

A Claude Code plugin that automatically captures every tool interaction in SQLite, scores and tags observations by importance, exports high-value context to Claude Code's auto-memory, and provides keyword, semantic, and tag-based search across your session history.

---

## Install

**Marketplace install (recommended — requires a server):**

Native SQLite binaries are not bundled with the marketplace plugin. Before installing, start a server on your machine. On macOS:

```bash
git clone https://github.com/mrlesmithjr/claude-context-manager
cd claude-context-manager
npm install && npm run build
make server-quickstart
```

Then in Claude Code:

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

Restart Claude Code to activate. See the [Setup Guide](docs/SETUP.md) for Docker (Linux) and advanced local-only options.

**Local install (advanced — for contributors and offline use):**

```bash
git clone https://github.com/mrlesmithjr/claude-context-manager
cd claude-context-manager
npm install
```

Then in Claude Code:

```
/plugin marketplace add /path/to/claude-context-manager
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
context_stats                          # overview of current project
context_list                           # recent sessions with summaries
context_search "auth"                  # keyword search
context_search "tag:database sqlite"   # tag-filtered search
context_decisions                      # recorded decisions from past sessions
context_lessons                        # error patterns and lessons learned
context_reflect                        # domain-grouped summary of recent activity
```

To enable semantic (vector) search, run `context_embed` once. It auto-installs dependencies (~265 MB) and bootstraps embeddings for existing sessions.

---

## Features

| Feature | Description |
|---------|-------------|
| Automatic capture | PostToolUse hook records every tool interaction with zero configuration |
| Importance scoring | Each observation scored 0.0-1.0 at capture time; classified as high/medium/low |
| Surprise scoring | First-time file encounters boosted; frequently-seen files decayed via 7-day windowed counter |
| Domain tag inference | Auto-tags with `auth`, `database`, `testing`, `infra`, `config`, `frontend`, `api`, `git`, `build`, `deps` |
| Retrieval routing | Short queries use FTS5; natural language uses vectors; mixed queries use Reciprocal Rank Fusion |
| Tag search | `tag:X` prefix in `context_search` routes directly to tag-filtered results; optional keyword for intersection |
| Temporal routing | Detects current/historical/neutral intent in search queries; boosts or orders results accordingly |
| Fuzzy search | Auto-corrects typos in search queries (Levenshtein distance <= 2, min frequency 3); correction shown in response header |
| Branch-aware capture | Git branch stored on every observation and session; soft-rank boost in search for current branch |
| Fact supersession | Conflicting facts (version, tech choice, etc.) auto-superseded on save; `include_superseded` param to opt in |
| Progressive disclosure | 3-layer retrieval: `context_search` (compact) → `context_get` (full detail) → `context_timeline` (session context) |
| Session summaries | Stop hook selects the best-scoring assistant message as the session narrative (score >= 0.25 threshold) |
| Conversation insights | High-signal assistant responses (tables, decisions, comparisons) extracted and stored as `Conversation` observations |
| Decisions tracking | `extractDecisions()` in Stop hook records architectural and technical decisions; queryable via `context_decisions` |
| Error lessons | Failed tool calls analyzed for lesson type; queryable via `context_lessons` with `lesson_type` filter |
| Reflection | `context_reflect` generates a domain-grouped summary of recent patterns, habits, and lessons |
| Memory decay | Importance scores decay over time (23-day half-life); pinned, decision, and lesson observations are exempt |
| Auto-memory export | Observations scoring >= 0.65 exported to `context-manager-activity.md` at session end |
| Semantic search | Session-level vector embeddings via sqlite-vec; enriched text from prompts and actions |
| Auto-compaction | Old observations compressed into summaries during vacuum (`Read x4: file1, file2, ...`) |
| Observation relationships | Observations linked by shared file (`same_file`), sequence (`followed_by`), and cross-project shared file; cross-project results shown in a separate section |
| Hierarchical visibility | Parent directories see all child project contexts via prefix matching |
| Memory audit | Detect orphaned memory directories when launch points change |
| Memory consolidation | Migrate orphaned memories to parent with dedup and index rebuild |
| Transcript import | Import historical sessions from Claude Code backups |
| Web dashboard | Browse sessions, search observations, view analytics at `http://localhost:3847` |
| PreCompact hook | Saves session state before `/compact` so context survives compaction |
| File-context injection | Before each Read, injects a compact history of prior work on that file (first read per file per session only) |
| Privacy tags | `<private>` tag excludes content from storage; `old_string`/`new_string`/`content` fields stripped from Edit/Write |
| Local storage | All data stays on your machine; no external APIs required |

---

## Configuration

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTEXT_MANAGER_DB` | `~/.claude-context/context.db` | Database path |
| `CONTEXT_MANAGER_TOKEN_BUDGET` | `4000` | Max tokens per MCP recall tool response (context_list, context_search) |
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
| `context_search` | Search observations and prompts. Auto-routes to FTS5, vector, or hybrid based on query length. Supports `tag:X` prefix, temporal intent detection (current/historical), branch filtering, and fuzzy typo correction. Returns compact one-line results by default. |
| `context_get` | Fetch full detail for specific observations by ID. Use after `context_search` to read complete content of results. Accepts up to 20 IDs. |
| `context_timeline` | Show session context around specific observation IDs. Returns the matched observations plus neighboring observations from the same session, giving chronological context for what was happening around each result. |
| `context_list` | List recent sessions with summaries and importance distribution |
| `context_list_projects` | List all project paths that have observations, with counts and last activity. Useful for discovering project scopes before using `context_add`. |
| `context_add` | Write a manual observation from any MCP client (Claude Desktop, etc.). Accepts `text` (required), `project`, `importance` ("high", "medium", "low", or float 0–1), and `tags` (comma-separated). |
| `context_stats` | Show statistics for the current project: observation counts, token usage, importance distribution, vector search status |
| `context_lessons` | List error lessons and patterns captured from failed tool calls. Supports `query`, `lesson_type`, and `days` filters. |
| `context_decisions` | List recorded decisions extracted from sessions. Supports free-text `query`. |
| `context_reflect` | Generate a reflection summary of recent patterns, habits, and lessons grouped by domain. Useful at the start of a session to orient to recent work. |
| `context_semantic_search` | Search sessions by meaning using enriched vector embeddings. Scoped to session level; use `context_search` for observation-level semantic search. |
| `context_embed` | Generate vector embeddings. First run installs dependencies (~265 MB) and bootstraps all sessions. |
| `context_vacuum` | Delete observations older than N days and run compaction. Stale session cleanup runs automatically on every session open; `context_vacuum` is for manual bulk cleanup. Optional `stale_session_hours` (default: 2) accepted for on-demand cleanup. |
| `context_prune` | Targeted pruning by tool name, importance, and/or age. Always use `dry_run=true` first. At least one filter required. |
| `context_export` | Trigger auto-memory export manually |
| `context_memory_audit` | Scan for orphaned memory directories when launch points change |
| `context_memory_consolidate` | Migrate orphaned memories to parent project (dry-run by default) |

---

## Deployment

> New to context-manager or setting up on a new machine? See the [Setup Guide](docs/SETUP.md) for a step-by-step walkthrough of all three deployment modes.

### Recommended: HTTP server + proxy mode

Run a central server so multiple machines share one database. Hooks become thin HTTP clients when `CONTEXT_MANAGER_URL` is set.

**macOS (recommended: launchd for reboot persistence)**

```bash
make server-quickstart
```

This one command generates a bearer token, writes `~/.claude-context/.env`, and installs two launchd agents: the MCP capture server (port 4000) and the web dashboard (port 3847). Both start automatically on login. Then restart Claude Code. Hooks read `.env` automatically, no shell configuration needed.

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
| `make server-launchd-install` | Install MCP capture server as launchd agent (macOS persistent startup) |
| `make server-launchd-uninstall` | Remove MCP capture server launchd agent |
| `make server-launchd-status` | Check MCP capture server launchd agent status |
| `make server-launchd-web-install` | Install web dashboard as launchd agent (macOS persistent startup) |
| `make server-launchd-web-uninstall` | Remove web dashboard launchd agent |
| `make server-launchd-web-status` | Check web dashboard launchd agent status |
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

### Advanced: local SQLite (no server)

Hooks write directly to `~/.claude-context/context.db` without any server. This requires cloning the repo and building from source — native SQLite binaries are not bundled with the marketplace plugin and hooks will fail at startup with an error if they are missing.

```bash
git clone https://github.com/mrlesmithjr/claude-context-manager
cd claude-context-manager
npm install
/plugin marketplace add /path/to/claude-context-manager   # in Claude Code
/plugin install context-manager
```

This mode is intended for contributors and users who need fully offline/embedded operation. See the [Setup Guide](docs/SETUP.md) for full details.

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
        SI["SessionStart\nstatus hint · session GC"]
        UP["UserPromptSubmit\ncapture prompt · checkpoint"]
        FC["PreToolUse\nfile history before Read"]
        PT["PostToolUse\nsummarize · score · tag · branch"]
        SE["Stop\nnarrative · insights · decisions · export"]
        PC["PreCompact\nsave session before /compact"]
    end

    subgraph db["SQLite ~/.claude-context/context.db"]
        OBS["observations\nimportance · tags · branch · embedding"]
        SES["sessions\nsummary · enriched_text · embedding"]
        DEC["decisions · lessons · token_index"]
    end

    subgraph out["Outputs"]
        MEM["Auto-Memory\ncontext-manager-activity.md"]
        MCP["MCP Tools\ncontext_search · context_get · context_timeline\ncontext_list · context_stats · context_add\ncontext_lessons · context_decisions · context_reflect\ncontext_embed · context_prune · context_vacuum\ncontext_export · context_memory_audit · +more"]
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
