#!/usr/bin/env bash
# Scenario 02: Cross-project isolation
#
# Verifies that observations for project-a are not visible when querying
# project-b via context_list, and vice versa.
#
# This tests the hierarchical project scoping logic in SQLiteStorage
# (prefix matching WHERE project LIKE path%).
#
# Precondition: setup-data.mjs has already run (called by run-all.sh).

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

PROJECT_A="${PROJECT_A:-/data/projects/project-a}"
PROJECT_B="${PROJECT_B:-/data/projects/project-b}"

info "Scenario 02: cross-project isolation"

# --- 02a: project-a observations are visible when scoped to project-a ---
info "02a: project-a observations visible from project-a scope"
A_TEXT=$(mcp_text 'context_list' "{\"project\":\"${PROJECT_A}\",\"limit\":10}")

assert_contains "$A_TEXT" "authentication middleware" \
  "02a: project-a scope shows authentication middleware (project-a observation)"

# --- 02b: project-a observations are NOT visible when scoped to project-b ---
info "02b: project-a observations not visible from project-b scope"
B_TEXT=$(mcp_text 'context_list' "{\"project\":\"${PROJECT_B}\",\"limit\":10}")

assert_not_contains "$B_TEXT" "authentication middleware" \
  "02b: project-b scope does not show project-a auth middleware observation"

assert_not_contains "$B_TEXT" "database schema migration" \
  "02b: project-b scope does not show project-a database migration observation"

# --- 02c: project-b observations ARE visible when scoped to project-b ---
info "02c: project-b observations visible from project-b scope"

assert_contains "$B_TEXT" "build pipeline" \
  "02c: project-b scope shows build pipeline observation (project-b)"

# --- 02d: parent scope sees both projects ---
info "02d: parent scope /data/projects/ sees both projects"
PARENT_TEXT=$(mcp_text 'context_list' "{\"project\":\"/data/projects\",\"limit\":20}")

assert_contains "$PARENT_TEXT" "authentication middleware" \
  "02d: parent scope shows project-a observation"

assert_contains "$PARENT_TEXT" "build pipeline" \
  "02d: parent scope shows project-b observation"

# --- 02e: search scoped to project-a excludes project-b content ---
# Guards against the silent false negative: if the server is down or the response
# is empty, assert_not_contains trivially passes on an empty string. We first
# confirm the server responded, then check the isolation.
info "02e: context_search scoped to project-a excludes project-b content"
SEARCH_A=$(mcp_text 'context_search' "{\"query\":\"build pipeline\",\"project\":\"${PROJECT_A}\"}")

if [ -z "$SEARCH_A" ]; then
  fail "02e: context_search returned empty response for project-a scope (server error or unexpected response)"
else
  # The "no results" message echoes the query, so we cannot assert_not_contains
  # on "build pipeline" -- it appears in "No observations found matching 'build pipeline'".
  # Instead, check that the actual project-b observation content is absent.
  assert_not_contains "$SEARCH_A" "webpack.config.js" \
    "02e: project-b file (webpack.config.js) not visible in project-a search"
  # Confirm search correctly returned no observations (not a server error)
  assert_contains "$SEARCH_A" "No observations found" \
    "02e: project-a search for 'build pipeline' returns no matching observations"
fi

scenario_result "02-cross-project"
