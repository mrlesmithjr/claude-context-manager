# Setup Guide

This guide walks you through installing and configuring claude-context-manager. It covers three deployment modes and helps you pick the right one for your situation.

---

## Pick your mode

| Mode | Best for | Data lives |
|------|----------|-----------|
| **Local SQLite** | Single machine, simplest setup | `~/.claude-context/context.db` on your machine |
| **Native server** (macOS) | Always-on MCP capture and web dashboard, single machine | `~/.claude-context/context.db` on your machine |
| **Docker server** | Linux, or macOS with Docker already running | Named Docker volume, shared across restarts |

**Quick decision:**

- Just want to get started with no configuration? Use **Local SQLite**.
- On macOS and want reliable MCP capture with automatic restart on login? Use **Native server**.
- Want the web dashboard always available, or on Linux, or running Docker already? Use **Docker server**.

You can switch between modes later. Your data is never deleted when switching.

---

## Mode 1: Local SQLite

This is the original mode. Hooks write directly to a local file. No server, no ports, no configuration required.

### Install

In Claude Code:

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

Restart Claude Code. Done. The plugin captures every tool interaction automatically.

### Verify

Run in any Claude Code session:

```
context_stats
```

You should see a summary of captured observations for the current project.

### What you get

- Automatic session capture and scoring in the background
- `context_stats`, `context_list`, `context_search` MCP tools
- Auto-memory export to `memory/context-manager-activity.md` at session end
- Web dashboard at `http://localhost:3847` when you run `npm run web` manually

### What you do not get in this mode

- A persistent web dashboard (you launch it manually when needed)
- Capture from multiple machines to one database

---

## Mode 2: Native server (macOS)

Runs the HTTP capture server as a persistent launchd agent. The server starts automatically at login and survives Claude Code restarts. The web dashboard is always available at `http://localhost:3847`.

### Prerequisites

- Plugin already installed (Mode 1 steps above)
- The repo cloned locally (for `make` commands): `git clone https://github.com/mrlesmithjr/claude-context-manager`
- Node.js 18+
- `npm install && npm run build` run once from the repo root

### Install

```bash
cd ~/Projects/Personal/claude-context-manager   # or wherever you cloned it
make server-quickstart
```

This single command:
1. Generates a random bearer token
2. Writes `~/.claude-context/.env` with the token and server URL
3. Builds the server
4. Installs and starts a launchd agent (`com.mrlesmithjr.context-manager`)

Then restart Claude Code. Hooks read `~/.claude-context/.env` automatically at startup. No shell configuration, `.zshrc` exports, or environment variables needed.

### Verify

```bash
make server-native-status
# Expected: context-manager server is healthy at http://localhost:4000 (native)
```

Open `http://localhost:3847` in your browser. You should see the web dashboard.

### What you get

Everything in Mode 1, plus:
- Persistent HTTP capture server on port 4000 (hook capture endpoint)
- Persistent web dashboard at `http://localhost:3847`
- Both services restart automatically on login

### Stop and start

```bash
make server-launchd-status           # check MCP server launchd agent status
make server-launchd-web-status       # check web dashboard launchd agent status
make server-stop-native              # stop both services without removing config
make server-launchd-install          # install/restart MCP server agent
make server-launchd-uninstall        # remove MCP server agent
make server-launchd-web-install      # install/restart web dashboard agent
make server-launchd-web-uninstall    # remove web dashboard agent
```

---

## Mode 3: Docker server

Runs both the capture server and web dashboard in Docker containers. Data lives in a named Docker volume. This is the recommended mode on Linux, and works on macOS if you prefer Docker over launchd.

### Prerequisites

- Plugin already installed (Mode 1 steps above)
- The repo cloned locally
- Node.js 18+ and `npm install && npm run build` run once
- Docker and Docker Compose v2 installed and running

### Install

```bash
cd ~/Projects/Personal/claude-context-manager
make server-init     # generate token, write ~/.claude-context/.env
make server-start    # build image and start both services
```

Then restart Claude Code. Hooks read `~/.claude-context/.env` automatically.

### Verify

```bash
make server-status
# Expected:
#   [OK]  MCP server   http://localhost:4000
#   [OK]  Web UI       http://localhost:3847
#   [mode] docker
```

Open `http://localhost:3847` in your browser.

### What you get

Everything in Mode 1, plus:
- MCP capture server on port 4000
- Web dashboard at `http://localhost:3847` with sessions, search, and analytics
- Data persists in a Docker named volume across restarts and image rebuilds

### Stop and start

```bash
make server-stop     # stop containers (data preserved in named volume)
make server-start    # restart
make server-logs     # tail logs
```

---

## Switching between modes

If you installed the native server (Mode 2) and want to move to Docker (Mode 3), or vice versa, use the migration commands. They stop the active mode, wait for ports to clear, and start the new mode automatically.

```bash
make switch-to-docker    # native -> Docker
make switch-to-native    # Docker -> native
```

If both modes happen to be running at the same time, `make server-status` will warn you and suggest which command to run.

---

## Bringing data from another machine

The web dashboard includes an **Import** tab. Use it to load a `context.db` file from another machine and merge it into the active database. Existing records are not duplicated.

1. On the source machine, locate your database:

   ```bash
   ls ~/.claude-context/context.db
   ```

2. Copy that file to the target machine (USB, scp, AirDrop, etc.).

3. On the target machine, open `http://localhost:3847` (requires Mode 2 or Mode 3).

4. Click the **Import** tab.

5. Drag and drop the `.db` file, then click **Import**.

6. After import completes, run `context_embed` in a Claude Code session to regenerate vector embeddings for semantic search.

> The Import tab is only available when the web server is running (Mode 2 or Mode 3). It is not available in local SQLite mode.

---

## Enabling semantic search

Semantic (vector) search is optional and requires a one-time setup. It downloads a local embedding model (~265 MB) and generates embeddings for all existing sessions.

In any Claude Code session:

```
context_embed
```

This only needs to run once. After that, new sessions are embedded automatically in the background. Semantic search powers the natural-language path in `context_search` and `context_semantic_search`.

---

## Updating the plugin

When a new version is available:

```bash
cd ~/Projects/Personal/claude-context-manager
git pull
npm install
npm run build:plugin
```

Then in Claude Code:

```
/plugin update context-manager
```

Restart Claude Code to apply the update.

> If you are running the native server or Docker server, rebuild and restart the server after updating:
>
> ```bash
> # Native:
> make server-stop-native && make server-launchd-install
>
> # Docker:
> make server-stop && make server-start
> ```

---

## Troubleshooting

**Hooks are not capturing anything**

Check the plugin is installed:

```
/plugin list
```

If not listed, reinstall: `/plugin install context-manager`, then restart.

**`context_stats` shows nothing**

The plugin scopes observations to the current working directory. Make sure you are running in a project directory, not `/` or `~`.

**Web dashboard shows no data**

If you are in Docker mode, the web UI requires a project to be selected (top-right dropdown). Pick a project path to see its sessions and observations.

**Port already in use error when starting the server**

```bash
make server-status   # check what is running
```

If the native launchd service is running and you want Docker instead:

```bash
make switch-to-docker
```

**Server was working, now hooks are not capturing**

Check that `~/.claude-context/.env` still exists and contains both `CONTEXT_MANAGER_URL` and `CONTEXT_MANAGER_TOKEN`. If that file is missing, hooks fall back to local SQLite silently. Re-run `make server-init` (it will not overwrite an existing file) or recreate the file manually.

**Checking which mode is active**

```bash
cat ~/.claude-context/.env
```

If `CONTEXT_MANAGER_URL` is set, the plugin is in proxy mode (sending to a server). If the file is empty or the variable is absent, it is in local SQLite mode.
