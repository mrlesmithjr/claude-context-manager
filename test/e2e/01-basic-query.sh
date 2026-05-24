#!/usr/bin/env bash
# Scenario 01: Basic HTTP MCP query
#
# Verifies that observations written to the shared SQLite DB are visible
# through the HTTP MCP API via context_list and context_search.
#
# Precondition: setup-data.mjs has already run (called by run-all.sh).

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

PROJECT_A="${PROJECT_A:-/data/projects/project-a}"

info "Scenario 01: basic HTTP MCP query via context_list and context_search"

# --- 01a: context_list returns sessions for project-a ---
info "01a: context_list returns sessions for project-a"
LIST_RESPONSE=$(mcp_call 'context_list' "{\"project\":\"${PROJECT_A}\",\"limit\":5}")
LIST_TEXT=$(echo "$LIST_RESPONSE" | jq -r '.result.content[0].text // empty')

assert_contains "$LIST_TEXT" "Session" \
  "01a: context_list response contains a Session entry"

assert_contains "$LIST_TEXT" "authentication middleware" \
  "01a: context_list shows high-importance auth middleware observation"

assert_contains "$LIST_TEXT" "database schema migration" \
  "01a: context_list shows high-importance database migration observation"

# --- 01b: context_search finds observations by keyword ---
info "01b: context_search keyword search"
SEARCH_RESPONSE=$(mcp_call 'context_search' "{\"query\":\"authentication\",\"project\":\"${PROJECT_A}\"}")
SEARCH_TEXT=$(echo "$SEARCH_RESPONSE" | jq -r '.result.content[0].text // empty')

assert_contains "$SEARCH_TEXT" "auth" \
  "01b: context_search finds observations matching 'authentication'"

# --- 01c: health endpoint responds without auth ---
info "01c: health endpoint is reachable"
HEALTH=$(curl -sf "${MCP_URL%/mcp}/health") || { fail "01c: health endpoint failed"; HEALTH=""; }
if [ -n "$HEALTH" ]; then
  assert_contains "$HEALTH" "ok" \
    "01c: health endpoint returns {status:ok}"
fi

# --- 01d: auth required - request without token is rejected ---
info "01d: unauthenticated request is rejected"
HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"context_stats","arguments":{}},"id":"no-auth"}')

if [ "$HTTP_STATUS" = "401" ]; then
  pass "01d: unauthenticated request returns 401"
else
  fail "01d: expected 401 for unauthenticated request, got ${HTTP_STATUS}"
fi

scenario_result "01-basic-query"
