#!/usr/bin/env bash
# Scenario 05: Remote capture endpoints (phases 5-6)
#
# Verifies that the /capture/* and /memory write endpoints work correctly:
#   a) POST /capture/session (create) creates a session visible via context_list
#   b) POST /capture/observation stores an observation visible via context_search
#   c) POST /capture/prompt stores a user prompt
#   d) POST /capture/export triggers server-side memory export
#   e) GET /memory returns the exported content
#   f) Auth is enforced on all capture endpoints
#
# These endpoints are the server-side counterparts of the remote-client.ts helpers
# used by hooks when CONTEXT_MANAGER_URL is set.

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

info "Scenario 05: remote capture endpoints"

TS=$(date +%s%N 2>/dev/null || date +%s)
TEST_PROJECT="/data/projects/remote-capture-${TS}"
TEST_SESSION="e2e-remote-session-${TS}"

# --- 05a: POST /capture/session (create) ---
info "05a: POST /capture/session (create) creates a session"

CREATE_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d "{\"action\":\"create\",\"session_id\":\"${TEST_SESSION}\",\"project\":\"${TEST_PROJECT}\"}")

if [ "$CREATE_STATUS" = "200" ]; then
  pass "05a: POST /capture/session (create) returned 200"
else
  fail "05a: POST /capture/session (create) returned ${CREATE_STATUS} (expected 200)"
fi

# --- 05b: POST /capture/observation stores observation visible via search ---
info "05b: POST /capture/observation stores an observation"

OBS_SUMMARY="Remote capture test observation for ${TS}"
OBS_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/observation" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d "{
    \"session_id\":\"${TEST_SESSION}\",
    \"project\":\"${TEST_PROJECT}\",
    \"tool_name\":\"Edit\",
    \"summary\":\"${OBS_SUMMARY}\",
    \"files_touched\":[\"${TEST_PROJECT}/src/main.ts\"],
    \"metadata\":{},
    \"token_estimate\":25,
    \"importance\":\"high\",
    \"importance_score\":0.82,
    \"created_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")

if [ "$OBS_STATUS" = "200" ]; then
  pass "05b: POST /capture/observation returned 200"
else
  fail "05b: POST /capture/observation returned ${OBS_STATUS} (expected 200)"
fi

# Verify the observation is visible via context_search
sleep 1
SEARCH_TEXT=$(mcp_text 'context_search' "{\"query\":\"Remote capture test observation\",\"project\":\"${TEST_PROJECT}\"}")
assert_contains "$SEARCH_TEXT" "Remote capture" \
  "05b: stored observation is visible via context_search"

# --- 05c: POST /capture/prompt stores a user prompt ---
info "05c: POST /capture/prompt stores a user prompt"

PROMPT_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/prompt" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d "{
    \"session_id\":\"${TEST_SESSION}\",
    \"project\":\"${TEST_PROJECT}\",
    \"prompt_number\":1,
    \"prompt_text\":\"Implement the remote capture feature\",
    \"created_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")

if [ "$PROMPT_STATUS" = "200" ]; then
  pass "05c: POST /capture/prompt returned 200"
else
  fail "05c: POST /capture/prompt returned ${PROMPT_STATUS} (expected 200)"
fi

# --- 05d: POST /capture/session (end) ends the session ---
info "05d: POST /capture/session (end) ends the session with a summary"

END_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d "{
    \"action\":\"end\",
    \"session_id\":\"${TEST_SESSION}\",
    \"summary\":\"Implemented remote capture endpoints for hook-to-server communication\"
  }")

if [ "$END_STATUS" = "200" ]; then
  pass "05d: POST /capture/session (end) returned 200"
else
  fail "05d: POST /capture/session (end) returned ${END_STATUS} (expected 200)"
fi

# --- 05e: POST /capture/export triggers memory export, GET /memory returns content ---
info "05e: POST /capture/export triggers server-side memory export"

EXPORT_RESPONSE=$(curl -sf \
  -X POST "${MCP_URL%/mcp}/capture/export" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d "{\"project\":\"${TEST_PROJECT}\"}" 2>/dev/null || echo '{}')

EXPORT_STATUS_FIELD=$(echo "$EXPORT_RESPONSE" | jq -r '.status // ""')
if [ "$EXPORT_STATUS_FIELD" = "ok" ]; then
  pass "05e: POST /capture/export returned status:ok"
else
  fail "05e: POST /capture/export returned unexpected response: $(echo "$EXPORT_RESPONSE" | head -3)"
fi

info "05e: GET /memory returns the exported content"
MEMORY_RESPONSE=$(curl -sf \
  "${MCP_URL%/mcp}/memory?project=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote('${TEST_PROJECT}', safe=''))" 2>/dev/null || echo "${TEST_PROJECT}")" \
  -H "Authorization: Bearer ${MCP_TOKEN}" 2>/dev/null || echo '{}')

MEMORY_CONTENT=$(echo "$MEMORY_RESPONSE" | jq -r '.content // ""')
# The memory file may be empty if no high-importance obs exceeded the threshold,
# but the endpoint itself must return 200 with a content field.
if echo "$MEMORY_RESPONSE" | jq -e '.content != null' > /dev/null 2>&1; then
  pass "05e: GET /memory returns a response with a content field"
else
  fail "05e: GET /memory returned unexpected response: $(echo "$MEMORY_RESPONSE" | head -3)"
fi

# --- 05f: auth is enforced on capture endpoints ---
info "05f: capture endpoints reject unauthenticated requests"

AUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/observation" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"noauth","project":"/test","tool_name":"Read","summary":"test","files_touched":[],"metadata":{},"token_estimate":10,"importance":"low","importance_score":0.2,"created_at":"2026-01-01T00:00:00Z"}')

if [ "$AUTH_STATUS" = "401" ]; then
  pass "05f: /capture/observation returns 401 without auth"
else
  fail "05f: /capture/observation returned ${AUTH_STATUS} without auth (expected 401)"
fi

# --- 05g: invalid action on /capture/session returns 400 ---
info "05g: invalid action on /capture/session returns 400"

BAD_ACTION_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL%/mcp}/capture/session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -d '{"action":"invalid","session_id":"test","project":"/test"}')

if [ "$BAD_ACTION_STATUS" = "400" ]; then
  pass "05g: invalid action returns 400"
else
  fail "05g: invalid action returned ${BAD_ACTION_STATUS} (expected 400)"
fi

scenario_result "05-remote-capture"
