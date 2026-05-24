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

COMPOSE_FILE := docker-compose.e2e.yml
COMPOSE := docker compose -f $(COMPOSE_FILE)
E2E_IMAGE := context-manager-e2e:latest

.PHONY: build test-unit test-e2e test-e2e-up test-e2e-down e2e-build e2e-clean

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
