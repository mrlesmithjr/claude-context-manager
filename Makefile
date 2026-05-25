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
LAUNCHD_LABEL    := com.mrlesmithjr.context-manager
LAUNCHD_PLIST    := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
NODE_BIN         := $(shell which node)

.PHONY: build test-unit test-e2e test-e2e-up test-e2e-down e2e-build e2e-clean \
        server-build server-clean server-init server-start server-stop server-logs \
        server-status server-env \
        server-native-start server-native-stop server-native-status \
        server-launchd-install server-launchd-uninstall server-launchd-status \
        server-quickstart

# --- Build ---

build:
	npm run build

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
server-start: server-init server-build
	@if [ ! -f "$(SERVER_ENV)" ]; then \
		echo "ERROR: $(SERVER_ENV) not found. Run 'make server-init' first."; exit 1; \
	fi
	$(SERVER_COMPOSE) --env-file "$(SERVER_ENV)" up -d
	@echo ""
	@echo "[server] context-manager HTTP server running at http://localhost:4000"
	@echo "  Health: curl -s http://localhost:4000/health"
	@echo "  Logs:   make server-logs"
	@echo ""
	@echo "If Claude Code hooks are not yet configured for remote mode:"
	@echo "  make server-env"

# Stop the server. Data in the named volume is preserved.
server-stop:
	$(SERVER_COMPOSE) --env-file "$(SERVER_ENV)" down

# Tail server logs.
server-logs:
	$(SERVER_COMPOSE) logs -f

# Check server health (does not require the env file).
server-status:
	@curl -sf http://localhost:4000/health \
		&& echo "  context-manager server is healthy at http://localhost:4000" \
		|| echo "  context-manager server is not responding on http://localhost:4000"

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
server-launchd-install: server-init build
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
	@launchctl list | grep "$(LAUNCHD_LABEL)" || echo "[launchd] context-manager agent is not loaded."

# One-shot macOS setup: generate token, write .env, install launchd agent.
# After this completes, restart Claude Code -- remote mode activates automatically.
# Hooks read ~/.claude-context/.env at startup; no shell exports or launchctl setenv needed.
server-quickstart: server-launchd-install
	@echo ""
	@echo "================================================================"
	@echo " context-manager server setup complete"
	@echo "================================================================"
	@echo ""
	@echo "Restart Claude Code to activate remote mode."
	@echo "Hooks will read ~/.claude-context/.env automatically."
	@echo ""
	@echo "Verify: make server-native-status"
	@echo "================================================================"
