# Setup Guide

This guide walks you through installing and configuring claude-context-manager. It covers three deployment modes and helps you pick the right one for your situation.

---

## Pick your mode

| Mode | Best for | Data lives |
|------|----------|-----------|
| **Native server** (macOS, recommended) | Always-on MCP capture and web dashboard, automatic restart on login | `~/.claude-context/context.db` on your machine |
| **Docker server** | Linux, or macOS with Docker already running | Named Docker volume, shared across restarts |
| **Local SQLite** (advanced) | Contributors, offline/embedded operation — requires cloning the repo | `~/.claude-context/context.db` on your machine |

> **Marketplace installs require a server.** Native SQLite binaries (`better-sqlite3`, `sqlite-vec`) are not bundled with the marketplace plugin. If you install via `/plugin install context-manager` without a running server, hooks will fail at startup with a message telling you to configure one. Set up Mode 1 or Mode 2 first, then install the plugin.

**Quick decision:**

- On macOS? Use **Native server** (Mode 1) — one command and you are done.
- On Linux, or already running Docker? Use **Docker server** (Mode 2).
- Contributing to the plugin or need fully offline/embedded operation? Use **Local SQLite** (Mode 3, advanced).

You can switch between modes later. Your data is never deleted when switching.

---

## Mode 1: Native server (macOS, recommended)

Runs the HTTP capture server as a persistent launchd agent. The server starts automatically at login and survives Claude Code restarts. The web dashboard is always available at `http://localhost:3847`.

### Prerequisites

- The repo cloned locally (for `make` commands): `git clone https://github.com/mrlesmithjr/claude-context-manager`
- Node.js 18+
- Xcode Command Line Tools (macOS): `xcode-select --install` (required to build native modules `better-sqlite3` and `sqlite-vec` during `npm install`)
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

Then install the plugin in Claude Code:

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

Restart Claude Code. Hooks read `~/.claude-context/.env` automatically at startup. No shell configuration, `.zshrc` exports, or environment variables needed.

### Verify

```bash
make server-native-status
# Expected: context-manager server is healthy at http://localhost:4000 (native)
```

Open `http://localhost:3847` in your browser. You should see the web dashboard.

### What you get

- Automatic session capture and scoring in the background
- `context_stats`, `context_list`, `context_search` MCP tools
- Auto-memory export to `memory/context-manager-activity.md` at session end
- Persistent HTTP capture server on port 4000 (hook capture endpoint)
- Persistent web dashboard at `http://localhost:3847`
- Both services restart automatically on login

### Stop and start

```bash
make server-restart                  # restart (auto-detects mode, preferred over mode-specific commands)
make server-apply-env                # apply .env changes to the running server
make server-launchd-status           # check MCP server launchd agent status
make server-launchd-web-status       # check web dashboard launchd agent status
make server-stop-native              # stop both services without removing config
make server-launchd-install          # install/restart MCP server agent
make server-launchd-uninstall        # remove MCP server agent
make server-launchd-web-install      # install/restart web dashboard agent
make server-launchd-web-uninstall    # remove web dashboard agent
```

---

## Mode 2: Docker server

Runs both the capture server and web dashboard in Docker containers. Data lives in a named Docker volume. This is the recommended mode on Linux, and works on macOS if you prefer Docker over launchd.

### Prerequisites

- The repo cloned locally
- Node.js 18+
- Xcode Command Line Tools (macOS): `xcode-select --install` (required to build native modules during `npm install`)
- `npm install && npm run build` run once from the repo root
- Docker and Docker Compose v2 installed and running

### Install

```bash
cd ~/Projects/Personal/claude-context-manager
make server-init     # generate token, write ~/.claude-context/.env
make server-start    # build image and start both services
```

Then install the plugin in Claude Code:

```
/plugin marketplace add https://github.com/mrlesmithjr/claude-context-manager
/plugin install context-manager
```

Restart Claude Code. Hooks read `~/.claude-context/.env` automatically.

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

- Automatic session capture and scoring in the background
- `context_stats`, `context_list`, `context_search` MCP tools
- Auto-memory export to `memory/context-manager-activity.md` at session end
- MCP capture server on port 4000
- Web dashboard at `http://localhost:3847` with sessions, search, and analytics
- Data persists in a Docker named volume across restarts and image rebuilds

### Stop and start

```bash
make server-restart        # restart (auto-detects mode)
make server-apply-env      # apply .env changes to the running containers
make server-stop           # stop containers (data preserved in named volume)
make server-start          # restart
make server-logs           # tail logs
```

---

## Mode 3: Local SQLite (advanced)

This mode requires cloning the repository and building from source. It is intended for contributors or users who need fully offline/embedded operation. Native SQLite binaries are not bundled with the marketplace plugin, so this mode is not available to marketplace installs — hooks will fail at startup with an error directing you to configure a server instead.

### Prerequisites

- The repo cloned locally: `git clone https://github.com/mrlesmithjr/claude-context-manager`
- Node.js 18+
- Xcode Command Line Tools (macOS): `xcode-select --install` (required to build `better-sqlite3` and `sqlite-vec`)
- `npm install` run from the repo root to build the native modules

### Install

From the repo root, add the plugin pointing at your local build:

```
/plugin marketplace add /path/to/claude-context-manager
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

## Switching between modes

If you installed the native server (Mode 1) and want to move to Docker (Mode 2), or vice versa, use the migration commands. They stop the active mode, wait for ports to clear, and start the new mode automatically.

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

3. On the target machine, open `http://localhost:3847` (requires Mode 1 or Mode 2).

4. Click the **Import** tab.

5. Drag and drop the `.db` file, then click **Import**.

6. After import completes, run `context_embed` in a Claude Code session to regenerate vector embeddings for semantic search.

> The Import tab is only available when the web server is running (Mode 1 or Mode 2). It is not available in local SQLite mode.

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

**If you installed from the marketplace (the standard path):**

`make update` is the single command. It pulls the latest changes, runs `npm install`, runs `npm run build:plugin` (which builds all components and syncs the version to `plugin.json` and `marketplace.json`), commits the built plugin artifacts, pushes to the current branch, and restarts the server if one is active. After it completes, follow the two manual steps it prints.

```bash
cd ~/Projects/Personal/claude-context-manager
make update
```

Then in Claude Code (after restarting):

```
/plugin update context-manager
```

Restart Claude Code to apply the update.

> Built plugin scripts must be committed and pushed to GitHub before `/plugin update` will see the new version. For marketplace installs, Claude Code pulls the plugin from GitHub, not from your local build. `make update` handles the commit and push automatically.

**If you want to rebuild and release without pulling** (for example, after making local changes):

```bash
npm version patch --no-git-tag-version
npm run build:plugin
git add plugin/scripts/ plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json package.json package-lock.json
git commit -m "chore: rebuild plugin scripts for vX.Y.Z, refs #N"
git push origin develop
```

Then `/plugin update context-manager` inside Claude Code and restart Claude Code.

---

## When to restart

Most restarts are handled by two commands: `make server-apply-env` when you change `.env`, and `make server-restart` when you change code or rebuild. The two things that cannot be automated are restarting Claude Code and running `/plugin update`.

| What changed | Command | Notes |
|---|---|---|
| Edited `~/.claude-context/.env` | `make server-apply-env` | Launchd reads env from its plist, not `.env` directly. This command regenerates the plist and reloads the agent. |
| Pulled new code (`git pull` + build) | `make server-restart` | After `npm run build` completes, restart the server to load the new binary. Or use `make update` for the full cycle. |
| Full version update | `make update` | Runs git pull, npm install, npm run build:plugin (syncs version to plugin.json + marketplace.json), commits and pushes built artifacts, and restarts the server. Two manual steps follow: restart Claude Code, then `/plugin update context-manager`. |
| Hook scripts changed only | `/plugin update` + restart Claude Code | No server restart needed. Hooks are fresh process spawns; only the plugin cache needs updating. |
| Hook-only env var changed (e.g., `CONTEXT_MANAGER_CHECKPOINT_INTERVAL`) | None | Hooks read `.env` on every invocation. Change takes effect on the next tool call. |
| Web dashboard client files only (`web/client/`) | None | Static files served from disk per request. Change is visible on next browser refresh. |
| Installed new npm packages (`npm install`) | `make server-restart` | Native modules (better-sqlite3, sqlite-vec) must be reloaded. |

> For native (launchd) mode, "restart" means `make server-launchd-install`, which unloads and reloads the agent with a freshly generated plist. `make server-restart` handles this automatically. You do not need to know which mode you are in.

---

## Troubleshooting

**`npm install` fails with build errors or `node-gyp` errors**

The native modules (`better-sqlite3`, `sqlite-vec`) require C++ build tools. On macOS, install Xcode Command Line Tools:

```bash
xcode-select --install
```

Then re-run `npm install`. If Xcode CLT is already installed but the error persists, try:

```bash
npm rebuild better-sqlite3
```

**Hooks are not capturing anything**

Check the plugin is installed:

```
/plugin list
```

If not listed, reinstall: `/plugin install context-manager`, then restart.

**Hooks fail at startup with a message about missing native modules**

This happens when the plugin was installed from the marketplace without a server configured. Native SQLite binaries are not bundled with marketplace installs. Set up Mode 1 (native server) or Mode 2 (Docker) and configure `~/.claude-context/.env` with `CONTEXT_MANAGER_URL` and `CONTEXT_MANAGER_TOKEN` before restarting Claude Code.

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
