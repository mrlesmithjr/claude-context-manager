# Makefile for claude-context-manager
#
# Primary targets:
#   test-e2e       Build, run all E2E scenarios, and tear down (CI-safe)
#   test-e2e-up    Start E2E services only (for manual exploration)
#   test-e2e-down  Stop and remove E2E containers and ephemeral volume
#   test-unit      Run Vitest unit tests (same as npm test)
#   build          Run full TypeScript build
#
# E2E tests require Docker and Docker Compose v2 (compose v2.20+).
# The `run` command in Compose v2 honors depends_on with service_healthy conditions.
# Compose v1 (docker-compose) does not support health conditions on `run`.

COMPOSE_FILE     := docker-compose.e2e.yml
COMPOSE          := docker compose -f $(COMPOSE_FILE)
E2E_IMAGE        := context-manager-e2e:latest

SERVER_IMAGE     := context-manager-server:latest
SERVER_ENV       := $(HOME)/.claude-context/.env
SERVER_COMPOSE   := docker compose -f docker-compose.server.yml
TEST_COMPOSE     := docker compose -f docker-compose.test.yml -p ctx-test
LAUNCHD_LABEL        := com.mrlesmithjr.context-manager
LAUNCHD_PLIST        := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_LABEL_WEB    := com.mrlesmithjr.context-manager-web
LAUNCHD_PLIST_WEB    := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL_WEB).plist
NODE_BIN         := $(shell which node)

.PHONY: help build rebuild-native test-unit test-e2e test-e2e-up test-e2e-down e2e-build e2e-clean \
        server-build server-clean server-init server-start server-stop server-logs \
        server-status server-env server-restart server-apply-env update release ship \
        server-native-start server-native-stop server-native-status \
        server-launchd-install server-launchd-uninstall server-launchd-status \
        server-quickstart server-stop-native switch-to-docker switch-to-native \
        server-launchd-web-install server-launchd-web-uninstall server-launchd-web-status \
        test-docker-start test-docker-stop

# --- Help (default target) ---

help:
	@echo "claude-context-manager"
	@echo ""
	@echo "Build"
	@echo "  make build               Build all components (hooks, CLI, web)"
	@echo "  make build:plugin        Build and prepare plugin for local install"
	@echo "  make test-unit           Run Vitest unit tests"
	@echo ""
	@echo "E2E tests (requires Docker)"
	@echo "  make test-e2e            Build, run all scenarios, tear down"
	@echo "  make test-e2e-up         Start services for manual exploration"
	@echo "  make test-e2e-down       Stop and remove containers"
	@echo "  make e2e-clean           Remove E2E image to force rebuild"
	@echo ""
	@echo "Server: macOS native (launchd)"
	@echo "  make server-quickstart   One-shot setup: token + both launchd agents"
	@echo "  make server-stop-native  Stop both agents (plists preserved)"
	@echo "  make server-launchd-install          Install/restart MCP server agent"
	@echo "  make server-launchd-uninstall        Remove MCP server agent"
	@echo "  make server-launchd-status           MCP server agent status"
	@echo "  make server-launchd-web-install      Install/restart web dashboard agent"
	@echo "  make server-launchd-web-uninstall    Remove web dashboard agent"
	@echo "  make server-launchd-web-status       Web dashboard agent status"
	@echo ""
	@echo "Server: Docker"
	@echo "  make server-init         Generate token, write ~/.claude-context/.env"
	@echo "  make server-build        Build Docker image"
	@echo "  make server-start        Start MCP server + web dashboard containers"
	@echo "  make server-stop         Stop containers (data preserved)"
	@echo "  make server-logs         Tail container logs"
	@echo "  make server-clean        Remove Docker image"
	@echo ""
	@echo "Server: shared"
	@echo "  make server-status       Health check + deployment mode detection"
	@echo "  make server-restart      Restart the active server (auto-detects mode)"
	@echo "  make server-apply-env    Propagate .env changes to the running server"
	@echo "  make server-env          Print remote mode env setup instructions"
	@echo "  make switch-to-docker    Stop native, start Docker"
	@echo "  make switch-to-native    Stop Docker, start native"
	@echo "  make test-docker-start   Run Docker stack alongside native (ports 4001/3848)"
	@echo "  make test-docker-stop    Stop test Docker stack"
	@echo ""
	@echo "Development"
	@echo "  make update              Pull, build, and restart server (then follow prompts)"
	@echo "  make release             Merge develop->main, tag, and publish to marketplace"
	@echo ""
	@echo "See docs/SETUP.md for a full setup walkthrough."

# --- Build ---

build:
	npm run build

rebuild-native:
	npm rebuild better-sqlite3 sqlite-vec

# --- Unit tests ---

test-unit:
	npm test

# --- E2E tests ---

# Build the E2E image. Rebuilds only when source files change (Docker layer cache).
e2e-build:
	$(COMPOSE) build --pull

# Start the context-server in the background (for manual exploration).
# After running this, you can interact with the HTTP server at
# http://localhost:4000/mcp (token: e2e-test-token).
test-e2e-up: e2e-build
	$(COMPOSE) up -d context-server
	@echo ""
	@echo "context-server is running. HTTP MCP endpoint: http://localhost:4000/mcp"
	@echo "  Token: e2e-test-token"
	@echo ""
	@echo "To run setup data manually:"
	@echo "  docker compose -f docker-compose.e2e.yml run --rm test-runner node /app/test/e2e/setup-data.mjs"
	@echo ""
	@echo "To stop: make test-e2e-down"

# Run the full E2E suite: build, start context-server, run test-runner, teardown.
# Teardown always runs even if scenarios fail, so no orphaned containers remain.
# Exits non-zero if any scenario failed.
test-e2e: e2e-build
	@echo "Starting E2E test run..."
	$(COMPOSE) run --rm test-runner; \
	  STATUS=$$?; \
	  $(MAKE) test-e2e-down; \
	  exit $$STATUS

# Stop and remove E2E containers and the ephemeral DB volume.
test-e2e-down:
	$(COMPOSE) down --volumes --remove-orphans

# Remove the E2E image to force a full rebuild on the next run.
e2e-clean: test-e2e-down
	docker image rm -f $(E2E_IMAGE) 2>/dev/null || true
	@echo "E2E image removed. Run 'make test-e2e' to rebuild."

# --- Local HTTP server (remote-mode for hooks) ---
#
# Runs the HTTP MCP server in Docker using a named volume for SQLite.
# Works on macOS and Linux (no bind mount, no WAL corruption).
#
# Quickstart:
#   make server-init   generate token, write ~/.claude-context/.env
#   make server-env    print env var setup instructions for Claude Code
#   make server-start  build image (if needed) and start the server

# Build the production server image from Dockerfile.server.
server-build:
	$(SERVER_COMPOSE) build --pull

# Remove the server image to force a full rebuild on the next run.
server-clean: server-stop
	docker image rm -f $(SERVER_IMAGE) 2>/dev/null || true
	@echo "Server image removed. Run 'make server-start' to rebuild."

# Generate a random bearer token and write it to ~/.claude-context/.env.
# Idempotent: will not overwrite an existing env file.
server-init:
	@mkdir -p "$(HOME)/.claude-context"
	@if [ -f "$(SERVER_ENV)" ]; then \
		echo "[server-init] $(SERVER_ENV) already exists, skipping token generation."; \
		echo "  Delete it and re-run to rotate the token."; \
	else \
		TOKEN=$$(openssl rand -hex 32); \
		printf 'CONTEXT_MANAGER_TOKEN=%s\nCONTEXT_MANAGER_URL=http://localhost:4000\n' "$$TOKEN" > "$(SERVER_ENV)"; \
		chmod 600 "$(SERVER_ENV)"; \
		echo "[server-init] Token written to $(SERVER_ENV)"; \
		echo "  Run 'make server-env' to see how to expose it to Claude Code."; \
	fi

# Print env var setup instructions for Claude Code hooks.
server-env: server-init
	@bash scripts/server-env.sh

# Build the server image (if needed) and start the server in the background.
# Reads the token from ~/.claude-context/.env.
# Pre-flight: exits with an actionable error if ports 4000 or 3847 are occupied.
server-start: server-init server-build
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		echo "ERROR: $(SERVER_ENV) not found. Run 'make server-init' first."; exit 1; \
	fi
	@CONFLICT=0; \
	LAUNCHD_ACTIVE=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL)"); \
	for PORT in 4000 3847; do \
		if lsof -i :$$PORT -t >/dev/null 2>&1; then \
			if [ "$$LAUNCHD_ACTIVE" -gt 0 ] && { [ "$$PORT" = "4000" ] || [ "$$PORT" = "3847" ]; }; then \
				echo "[server-start] Port $$PORT is occupied by a native launchd service."; \
				echo "  To switch to Docker mode: make switch-to-docker"; \
			else \
				PID=$$(lsof -i :$$PORT -t | head -1); \
				echo "[server-start] Port $$PORT is occupied (PID $$PID). Stop that process first."; \
			fi; \
			CONFLICT=1; \
		fi; \
	done; \
	if [ "$$CONFLICT" -eq 1 ]; then exit 1; fi
	$(SERVER_COMPOSE) --env-file "$(SERVER_ENV)" up -d
	@echo ""
	@echo "[server] context-manager services running:"
	@echo "  MCP server:    http://localhost:4000  (hook capture endpoint)"
	@echo "  Web dashboard: http://localhost:3847"
	@echo "  Logs:   make server-logs"
	@echo "  Status: make server-status"
	@echo ""
	@echo "If Claude Code hooks are not yet configured for remote mode:"
	@echo "  make server-env"

# Stop the server. Data in the named volume is preserved.
server-stop:
	$(SERVER_COMPOSE) --env-file "$(SERVER_ENV)" down

# Tail server logs.
server-logs:
	$(SERVER_COMPOSE) logs -f

# Check server health and detect deployment-mode conflicts.
server-status:
	@curl -sf http://localhost:4000/health \
		&& echo "  [OK]  MCP server   http://localhost:4000" \
		|| echo "  [--]  MCP server   http://localhost:4000 (not responding)"
	@curl -sf http://localhost:3847/api/health \
		&& echo "  [OK]  Web UI       http://localhost:3847" \
		|| echo "  [--]  Web UI       http://localhost:3847 (not responding)"
	@NATIVE_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL)"); \
	DOCKER_ON=$$(docker ps --filter "name=context-manager" --format "{{.Names}}" 2>/dev/null | grep -c .); \
	if [ "$$NATIVE_ON" -gt 0 ] && [ "$$DOCKER_ON" -gt 0 ]; then \
		echo ""; \
		echo "  [WARN] Both native (launchd) and Docker services appear to be active."; \
		echo "         This will cause port conflicts. To resolve:"; \
		echo "           make switch-to-docker  -- stop native, start Docker"; \
		echo "           make switch-to-native  -- stop Docker, start native"; \
	elif [ "$$NATIVE_ON" -gt 0 ]; then \
		echo "  [mode] native (launchd)"; \
	elif [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "  [mode] docker"; \
	fi

# Restart the active server. Detects mode (launchd vs Docker) and restarts accordingly.
# For launchd: runs server-launchd-install (regenerates plist, unloads/loads agent).
# For Docker: stops and starts the compose stack.
# Exits non-zero if no server is running or if both modes are active simultaneously.
server-restart:
	@NATIVE_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL)$$"); \
	DOCKER_ON=$$(docker ps --filter "name=context-manager" --format "{{.Names}}" 2>/dev/null | grep -c .); \
	if [ "$$NATIVE_ON" -gt 0 ] && [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "ERROR: Both native (launchd) and Docker services appear active."; \
		echo "  This is a conflict state. Run 'make server-status' to diagnose,"; \
		echo "  then use 'make switch-to-docker' or 'make switch-to-native' to resolve."; \
		exit 1; \
	elif [ "$$NATIVE_ON" -gt 0 ]; then \
		echo "[restart] Mode: native (launchd). Restarting all agents..."; \
		$(MAKE) server-launchd-install; \
		WEB_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL_WEB)$$"); \
		if [ "$$WEB_ON" -gt 0 ]; then \
			$(MAKE) server-launchd-web-install; \
		fi; \
		echo ""; \
		echo "[restart] All native agents restarted."; \
		echo "  Verify: make server-status"; \
	elif [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "[restart] Mode: Docker. Stopping and starting compose stack..."; \
		$(MAKE) server-stop; \
		$(MAKE) server-start; \
		echo ""; \
		echo "[restart] Docker services restarted."; \
		echo "  Verify: make server-status"; \
	else \
		echo "ERROR: No active server detected (neither launchd nor Docker)."; \
		echo "  To start native:  make server-quickstart"; \
		echo "  To start Docker:  make server-start"; \
		exit 1; \
	fi

# Propagate ~/.claude-context/.env changes to the running server.
#
# Launchd agents read env vars from the plist, NOT from .env at runtime.
# Editing .env alone has no effect on a running launchd agent.
# This target regenerates the plist from the current .env and reloads the agent.
#
# Docker compose reads env vars from the shell environment at 'up' time.
# This target re-sources .env and recreates the containers.
#
# For local SQLite mode (no server), .env changes take effect on the next
# Claude Code tool call -- hooks re-read .env on every invocation.
server-apply-env:
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		echo "ERROR: $(SERVER_ENV) not found."; \
		echo "  Run 'make server-init' to generate a token and create the file."; \
		exit 1; \
	fi
	@NATIVE_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL)$$"); \
	DOCKER_ON=$$(docker ps --filter "name=context-manager" --format "{{.Names}}" 2>/dev/null | grep -c .); \
	if [ "$$NATIVE_ON" -gt 0 ] && [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "ERROR: Both native (launchd) and Docker services appear active."; \
		echo "  Run 'make server-status' to diagnose the conflict."; \
		exit 1; \
	elif [ "$$NATIVE_ON" -gt 0 ]; then \
		echo "[apply-env] Mode: native (launchd). Regenerating plist from current .env..."; \
		$(MAKE) server-launchd-install; \
		WEB_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL_WEB)"); \
		if [ "$$WEB_ON" -gt 0 ]; then \
			echo "[apply-env] Web agent is loaded. Regenerating web plist from current .env..."; \
			$(MAKE) server-launchd-web-install; \
		fi; \
		echo ""; \
		echo "[apply-env] Launchd agents updated with current .env values."; \
		echo ""; \
		echo "  Hooks pick up .env changes automatically on next tool call."; \
		echo "  Server now has the updated configuration."; \
	elif [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "[apply-env] Mode: Docker. Recreating containers with current .env values..."; \
		set -a && . "$(SERVER_ENV)" && set +a && \
		$(SERVER_COMPOSE) down && $(SERVER_COMPOSE) up -d; \
		echo ""; \
		echo "[apply-env] Docker containers restarted with current .env values."; \
		echo ""; \
		echo "  Hooks pick up .env changes automatically on next tool call."; \
		echo "  Server now has the updated configuration."; \
	else \
		echo "[apply-env] Mode: local SQLite (no server running)."; \
		echo "  .env changes take effect on the next Claude Code tool call."; \
		echo "  No server restart needed."; \
	fi
	@if [ -f "$(SERVER_ENV)" ] && grep -q "CONTEXT_MANAGER_URL\|CONTEXT_MANAGER_TOKEN" "$(SERVER_ENV)" 2>/dev/null; then \
		echo ""; \
		echo "  NOTE: CONTEXT_MANAGER_URL or CONTEXT_MANAGER_TOKEN found in .env."; \
		echo "  The MCP stdio server (Claude Code's MCP connection) reads these at"; \
		echo "  startup. If MCP tool responses seem stale, restart Claude Code."; \
	fi

# Full update cycle: pull latest changes, rebuild, and restart the server if active.
# After this completes, follow the manual steps printed at the end.
update:
	@echo "[update] Pulling latest changes..."
	@PULL_OUT=$$(git pull 2>&1); PULL_EXIT=$$?; \
	echo "$$PULL_OUT"; \
	if [ "$$PULL_EXIT" -ne 0 ] && ! echo "$$PULL_OUT" | grep -q "Already up to date"; then \
		echo "ERROR: git pull failed (exit $$PULL_EXIT). Resolve the issue and re-run make update."; \
		exit 1; \
	fi; \
	if echo "$$PULL_OUT" | grep -q "Already up to date"; then \
		echo "[update] Already up to date. Running build anyway (local changes may be present)."; \
	fi
	@echo ""
	@echo "[update] Installing dependencies..."
	npm install
	@echo ""
	@echo "[update] Building (including plugin preparation)..."
	npm run build:plugin
	@echo ""
	@echo "[update] Committing built plugin artifacts..."
	@VERSION=$$(node -p "require('./package.json').version"); \
	if [ -n "$$(git status --porcelain)" ]; then \
		git add plugin/scripts/ plugin/.claude-plugin/plugin.json .claude-plugin/marketplace.json && \
		git commit -m "chore: rebuild plugin scripts for v$$VERSION, refs #95" && \
		BRANCH=$$(git branch --show-current) && \
		echo "[update] Pushing branch $$BRANCH..." && \
		if ! git push origin "$$BRANCH"; then \
			echo "ERROR: git push failed. Check remote access and re-run 'git push origin $$BRANCH' manually."; \
			exit 1; \
		fi && \
		echo "[update] Plugin artifacts committed and pushed (v$$VERSION)."; \
	else \
		echo "[update] No changes to commit -- plugin artifacts are already current."; \
	fi
	@echo ""
	@NATIVE_ON=$$(launchctl list 2>/dev/null | grep -c "$(LAUNCHD_LABEL)$$"); \
	DOCKER_ON=$$(docker ps --filter "name=context-manager" --format "{{.Names}}" 2>/dev/null | grep -c .); \
	if [ "$$NATIVE_ON" -gt 0 ] || [ "$$DOCKER_ON" -gt 0 ]; then \
		echo "[update] Server is active. Restarting..."; \
		$(MAKE) server-restart; \
	else \
		echo "[update] No server running (local SQLite mode). Skipping server restart."; \
	fi
	@echo ""
	@echo "================================================================"
	@echo " Update complete."
	@echo ""
	@echo " Two manual steps remain:"
	@echo "   1. Restart Claude Code  (Cmd+Q and reopen, or /exit in terminal mode)"
	@echo "   2. /plugin update context-manager  (run inside Claude Code after restart)"
	@echo "================================================================"

# Full ship cycle: bump patch version, build + push develop, merge to main, tag.
# Use this after code review passes. One command replaces the three-step manual flow.
# After it completes, run /plugin update context-manager inside Claude Code.
ship:
	@echo "[ship] Bumping patch version..."
	@npm version patch --no-git-tag-version
	@VERSION=$$(node -p "require('./package.json').version"); \
	git add package.json package-lock.json && \
	git commit -m "chore: bump version to v$$VERSION"
	$(MAKE) update
	$(MAKE) release

# Merge develop -> main, tag the release, and surface it to the marketplace.
#
# Prerequisites (must be done first):
#   npm version patch --no-git-tag-version   bump the version
#   make update                              build artifacts, commit, push to develop
#
# What this does:
#   1. Opens a PR from develop -> main (or reuses an existing one)
#   2. Polls CI until the `test` check passes (fails fast on CI failure)
#   3. Squash-merges the PR
#   4. Tags the new main HEAD as v<version> and pushes the tag
#   5. Merges main back into develop to prevent squash-merge divergence on the
#      next release (squash commits on main are not ancestors of develop, so
#      a follow-up merge would hit conflicts without this sync step)
#
# After this completes, run /plugin update context-manager inside Claude Code.
release:
	@BRANCH=$$(git branch --show-current); \
	if [ "$$BRANCH" != "develop" ]; then \
		echo "ERROR: run 'make release' from 'develop' (currently on '$$BRANCH')."; \
		exit 1; \
	fi; \
	if [ -n "$$(git status --porcelain)" ]; then \
		echo "ERROR: uncommitted changes present -- commit and push first."; \
		exit 1; \
	fi; \
	AHEAD=$$(git rev-list origin/develop..develop --count 2>/dev/null || echo "0"); \
	if [ "$$AHEAD" -gt 0 ]; then \
		echo "ERROR: local develop is ahead of origin -- run 'git push' first."; \
		exit 1; \
	fi; \
	VERSION=$$(node -p "require('./package.json').version"); \
	echo "[release] v$$VERSION: develop -> main"; \
	PR_OUTPUT=$$(gh pr create \
		--repo mrlesmithjr/claude-context-manager \
		--base main --head develop \
		--title "Release: v$$VERSION" \
		--body "Release v$$VERSION." 2>&1); \
	PR_EXIT=$$?; \
	if [ "$$PR_EXIT" -ne 0 ]; then \
		if echo "$$PR_OUTPUT" | grep -qi "already exists"; then \
			PR_NUM=$$(gh pr list \
				--repo mrlesmithjr/claude-context-manager \
				--base main --head develop \
				--json number --jq '.[0].number'); \
			echo "[release] Reusing existing PR #$$PR_NUM"; \
		else \
			echo "ERROR: gh pr create failed:"; echo "$$PR_OUTPUT"; exit 1; \
		fi; \
	else \
		PR_NUM=$$(echo "$$PR_OUTPUT" | grep -oE '[0-9]+$$'); \
		echo "[release] PR #$$PR_NUM created"; \
	fi; \
	echo "[release] Waiting for CI on PR #$$PR_NUM (polling every 10s)..."; \
	sleep 5; \
	while gh pr checks "$$PR_NUM" \
			--repo mrlesmithjr/claude-context-manager 2>&1 | grep -qE "pending|queued"; do \
		printf "."; sleep 10; \
	done; \
	echo ""; \
	if gh pr checks "$$PR_NUM" \
			--repo mrlesmithjr/claude-context-manager 2>&1 | grep -q "fail"; then \
		echo "ERROR: CI checks failed:"; \
		gh pr checks "$$PR_NUM" --repo mrlesmithjr/claude-context-manager 2>&1; \
		exit 1; \
	fi; \
	echo "[release] CI passed. Merging PR #$$PR_NUM..."; \
	if ! gh pr merge "$$PR_NUM" --repo mrlesmithjr/claude-context-manager --squash --admin; then \
		echo "ERROR: PR merge failed. Check for conflicts: gh pr view $$PR_NUM"; \
		exit 1; \
	fi; \
	git fetch origin main; \
	git tag "v$$VERSION" origin/main 2>/dev/null \
		|| echo "[release] Tag v$$VERSION already exists, skipping."; \
	git push origin "v$$VERSION" 2>/dev/null \
		|| echo "[release] Tag already on remote, skipping."; \
	echo "[release] Creating GitHub Release v$$VERSION..."; \
	gh release create "v$$VERSION" \
		--repo mrlesmithjr/claude-context-manager \
		--title "Release: v$$VERSION" \
		--target main \
		--generate-notes 2>/dev/null \
		|| echo "[release] GitHub Release already exists, skipping."; \
	echo "[release] Syncing main back into develop to prevent future merge conflicts..."; \
	git merge origin/main --no-edit -X ours 2>&1 \
		&& git push origin develop \
		|| echo "[WARN] Could not auto-sync main into develop. Run: git merge origin/main && git push"; \
	echo ""; \
	echo "================================================================"; \
	echo " v$$VERSION is live on main and tagged."; \
	echo " Next: /plugin update context-manager  (inside Claude Code)"; \
	echo "================================================================"

# --- Native server (macOS recommended) ---
#
# On macOS, Docker Desktop uses a Linux VM with VirtioFS for bind mounts.
# SQLite WAL mode requires POSIX advisory locks that do not work correctly
# across this virtualization layer, causing "database disk image is malformed"
# errors. Running the server natively avoids this entirely.
#
# Use 'make server-launchd-install' for persistent startup across reboots.
# Use 'make server-native-start' for a one-shot foreground-safe start.

# Start the native server in the background (one-shot, no persistence).
server-native-start: server-init build
	@if lsof -i :4000 >/dev/null 2>&1; then \
		echo "[native] Port 4000 already in use -- server may already be running."; \
		echo "  Check: make server-native-status"; \
	else \
		source "$(SERVER_ENV)" && \
		CONTEXT_MANAGER_DB="$(HOME)/.claude-context/context.db" \
		CONTEXT_MANAGER_TOKEN="$$CONTEXT_MANAGER_TOKEN" \
		CONTEXT_MANAGER_PORT=4000 \
		CONTEXT_MANAGER_HOST=127.0.0.1 \
		LOG_LEVEL=warn \
		nohup "$(NODE_BIN)" "$(CURDIR)/test/e2e/start-server.mjs" \
			>> "$(HOME)/.claude-context/server.log" 2>&1 & \
		echo "$$!" > "$(HOME)/.claude-context/server.pid"; \
		sleep 1; \
		make server-native-status; \
	fi

# Stop the native background server.
server-native-stop:
	@if [ -f "$(HOME)/.claude-context/server.pid" ]; then \
		PID=$$(cat "$(HOME)/.claude-context/server.pid"); \
		if kill -0 "$$PID" 2>/dev/null; then \
			kill "$$PID" && echo "[native] Stopped context-manager server (PID $$PID)"; \
		else \
			echo "[native] Server PID $$PID is not running."; \
		fi; \
		rm -f "$(HOME)/.claude-context/server.pid"; \
	else \
		echo "[native] No server.pid found -- trying lsof fallback."; \
		lsof -i :4000 -t | xargs kill 2>/dev/null && echo "[native] Killed process on :4000" || true; \
	fi

# Check native server health.
server-native-status:
	@curl -sf http://localhost:4000/health \
		&& echo "  context-manager server is healthy at http://localhost:4000 (native)" \
		|| echo "  context-manager server is not responding on http://localhost:4000"

# Install launchd agent for automatic startup on macOS login.
# Reads token from ~/.claude-context/.env. Must run 'make server-init' first.
server-launchd-install: server-init rebuild-native build
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		echo "ERROR: $(SERVER_ENV) not found. Run 'make server-init' first."; exit 1; \
	fi
	@source "$(SERVER_ENV)" && TOKEN="$$CONTEXT_MANAGER_TOKEN" && \
	sed \
		-e "s|{{NODE_PATH}}|$(NODE_BIN)|g" \
		-e "s|{{PROJECT_ROOT}}|$(CURDIR)|g" \
		-e "s|{{HOME}}|$(HOME)|g" \
		-e "s|{{TOKEN}}|$$TOKEN|g" \
		scripts/com.mrlesmithjr.context-manager.plist.template \
		> "$(LAUNCHD_PLIST)" && \
	launchctl unload "$(LAUNCHD_PLIST)" 2>/dev/null || true && \
	launchctl load "$(LAUNCHD_PLIST)" && \
	echo "[launchd] context-manager agent installed and started." && \
	echo "  Plist: $(LAUNCHD_PLIST)" && \
	echo "  Logs:  $(HOME)/.claude-context/server.log" && \
	sleep 2 && make server-native-status

# Remove launchd agent.
server-launchd-uninstall:
	@if [ -f "$(LAUNCHD_PLIST)" ]; then \
		launchctl unload "$(LAUNCHD_PLIST)" 2>/dev/null || true; \
		rm -f "$(LAUNCHD_PLIST)"; \
		echo "[launchd] context-manager agent removed."; \
	else \
		echo "[launchd] No plist found at $(LAUNCHD_PLIST)."; \
	fi

# Show launchd agent status.
server-launchd-status:
	@launchctl list | grep "$(LAUNCHD_LABEL)$$" || echo "[launchd] context-manager MCP agent is not loaded."

# Install launchd agent for the web dashboard (port 3847) on macOS.
# Reads token from ~/.claude-context/.env. Binds to 127.0.0.1 (local-only, no bearer auth required).
server-launchd-web-install: server-init build
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		echo "ERROR: $(SERVER_ENV) not found. Run 'make server-init' first."; exit 1; \
	fi
	@source "$(SERVER_ENV)" && TOKEN="$$CONTEXT_MANAGER_TOKEN" && \
	sed \
		-e "s|{{NODE_PATH}}|$(NODE_BIN)|g" \
		-e "s|{{PROJECT_ROOT}}|$(CURDIR)|g" \
		-e "s|{{HOME}}|$(HOME)|g" \
		-e "s|{{TOKEN}}|$$TOKEN|g" \
		scripts/com.mrlesmithjr.context-manager-web.plist.template \
		> "$(LAUNCHD_PLIST_WEB)" && \
	launchctl unload "$(LAUNCHD_PLIST_WEB)" 2>/dev/null || true && \
	launchctl load "$(LAUNCHD_PLIST_WEB)" && \
	echo "[launchd-web] Web dashboard agent installed and started." && \
	echo "  Plist: $(LAUNCHD_PLIST_WEB)" && \
	echo "  Logs:  $(HOME)/.claude-context/web.log" && \
	sleep 2 && make server-launchd-web-status

# Remove web dashboard launchd agent.
server-launchd-web-uninstall:
	@if [ -f "$(LAUNCHD_PLIST_WEB)" ]; then \
		launchctl unload "$(LAUNCHD_PLIST_WEB)" 2>/dev/null || true; \
		rm -f "$(LAUNCHD_PLIST_WEB)"; \
		echo "[launchd-web] Web dashboard agent removed."; \
	else \
		echo "[launchd-web] No plist found at $(LAUNCHD_PLIST_WEB)."; \
	fi

# Show web dashboard launchd agent status.
server-launchd-web-status:
	@launchctl list | grep "$(LAUNCHD_LABEL_WEB)" || echo "[launchd-web] context-manager web agent is not loaded."

# Stop the native launchd service without removing the plist.
# The plist stays in place so 'make server-launchd-install' can restart it later.
# Falls back to server.pid kill for the one-shot nohup path.
server-stop-native:
	@if launchctl list 2>/dev/null | grep -q "$(LAUNCHD_LABEL)$$"; then \
		launchctl unload "$(LAUNCHD_PLIST)" 2>/dev/null && \
			echo "[native] MCP service unloaded (plist preserved)." || \
			echo "[native] MCP launchctl unload failed."; \
	else \
		echo "[native] MCP launchd service is not loaded."; \
		PID_FILE="$(HOME)/.claude-context/server.pid"; \
		if [ -f "$$PID_FILE" ]; then \
			PID=$$(cat "$$PID_FILE"); \
			if kill -0 "$$PID" 2>/dev/null; then \
				kill "$$PID" && echo "[native] Stopped background MCP server (PID $$PID)."; \
			fi; \
			rm -f "$$PID_FILE"; \
		fi; \
	fi
	@if launchctl list 2>/dev/null | grep -q "$(LAUNCHD_LABEL_WEB)$$"; then \
		launchctl unload "$(LAUNCHD_PLIST_WEB)" 2>/dev/null && \
			echo "[native] Web service unloaded (plist preserved)." || \
			echo "[native] Web launchctl unload failed."; \
	else \
		echo "[native] Web launchd service is not loaded."; \
	fi
	@for PORT in 4000 3847; do \
		if lsof -i :$$PORT -t >/dev/null 2>&1; then \
			echo "[native] WARNING: Port $$PORT is still occupied after stop attempt."; \
		else \
			echo "[native] Port $$PORT is free."; \
		fi; \
	done

# One-shot macOS setup: generate token, write .env, install both launchd agents.
# After this completes, restart Claude Code -- remote mode activates automatically.
# Hooks read ~/.claude-context/.env at startup; no shell exports or launchctl setenv needed.
server-quickstart: server-launchd-install server-launchd-web-install
	@echo ""
	@echo "================================================================"
	@echo " context-manager setup complete"
	@echo "================================================================"
	@echo ""
	@echo "Restart Claude Code to activate remote mode."
	@echo "Hooks will read ~/.claude-context/.env automatically."
	@echo ""
	@echo "  MCP server:    http://localhost:4000  (hook capture)"
	@echo "  Web dashboard: http://localhost:3847"
	@echo ""
	@echo "Verify: make server-status"
	@echo "================================================================"

# --- Deployment mode migration ---
#
# Use these targets to switch between native (launchd) and Docker deployments
# without manual port cleanup. Both targets verify ports are free before starting
# the new deployment and fail with a clear error if they are not.

# Stop the native launchd service and start the Docker stack on the same ports.
switch-to-docker: server-stop-native
	@i=0; while [ $$i -lt 5 ]; do \
		if lsof -i :4000 -t >/dev/null 2>&1 || lsof -i :3847 -t >/dev/null 2>&1; then \
			echo "[switch] Waiting for ports to clear ($$((i+1))/5)..."; \
			sleep 1; i=$$((i+1)); \
		else \
			break; \
		fi; \
	done; \
	if lsof -i :4000 -t >/dev/null 2>&1; then \
		echo "ERROR: Port 4000 is still occupied. Cannot start Docker services."; exit 1; \
	fi; \
	if lsof -i :3847 -t >/dev/null 2>&1; then \
		echo "ERROR: Port 3847 is still occupied. Cannot start Docker services."; exit 1; \
	fi; \
	echo "[switch] Ports are free. Starting Docker services..."
	$(MAKE) server-start

# Stop the Docker stack and start the native launchd service on the same ports.
switch-to-native:
	@echo "[switch] Stopping Docker services..."
	$(SERVER_COMPOSE) --env-file "$(SERVER_ENV)" down 2>/dev/null || true
	@i=0; while [ $$i -lt 5 ]; do \
		if lsof -i :4000 -t >/dev/null 2>&1 || lsof -i :3847 -t >/dev/null 2>&1; then \
			echo "[switch] Waiting for ports to clear ($$((i+1))/5)..."; \
			sleep 1; i=$$((i+1)); \
		else \
			break; \
		fi; \
	done; \
	if lsof -i :4000 -t >/dev/null 2>&1; then \
		echo "ERROR: Port 4000 is still occupied. Cannot start native service."; exit 1; \
	fi; \
	if lsof -i :3847 -t >/dev/null 2>&1; then \
		echo "ERROR: Port 3847 is still occupied. Cannot start native service."; exit 1; \
	fi; \
	echo "[switch] Ports are free. Installing native launchd services..."
	$(MAKE) server-launchd-install
	$(MAKE) server-launchd-web-install

# Run Docker stack on alternate ports alongside the native server (refs #241).
# MCP server:    http://localhost:4001  (native uses 4000)
# Web dashboard: http://localhost:3848  (native uses 3847)
# Data volume:   context-manager-test-data (isolated from production)
test-docker-start: server-build
	$(TEST_COMPOSE) --env-file "$(SERVER_ENV)" up -d
	@echo ""
	@echo "[test-docker] Test stack running:"
	@echo "  MCP server:    http://localhost:4001"
	@echo "  Web dashboard: http://localhost:3848"
	@echo "  Logs:   docker compose -p ctx-test logs -f"
	@echo "  Stop:   make test-docker-stop"

# Stop and remove test containers (preserves the test data volume).
test-docker-stop:
	$(TEST_COMPOSE) --env-file "$(SERVER_ENV)" down
