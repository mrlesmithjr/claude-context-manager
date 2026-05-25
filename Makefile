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
LAUNCHD_LABEL        := com.mrlesmithjr.context-manager
LAUNCHD_PLIST        := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_LABEL_WEB    := com.mrlesmithjr.context-manager-web
LAUNCHD_PLIST_WEB    := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL_WEB).plist
NODE_BIN         := $(shell which node)

.PHONY: help build test-unit test-e2e test-e2e-up test-e2e-down e2e-build e2e-clean \
        server-build server-clean server-init server-start server-stop server-logs \
        server-status server-env \
        server-native-start server-native-stop server-native-status \
        server-launchd-install server-launchd-uninstall server-launchd-status \
        server-quickstart server-stop-native switch-to-docker switch-to-native \
        server-launchd-web-install server-launchd-web-uninstall server-launchd-web-status

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
	@echo "  make server-env          Print remote mode env setup instructions"
	@echo "  make switch-to-docker    Stop native, start Docker"
	@echo "  make switch-to-native    Stop Docker, start native"
	@echo ""
	@echo "See docs/SETUP.md for a full setup walkthrough."

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
