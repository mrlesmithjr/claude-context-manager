#!/usr/bin/env bash
# Scenario 06: Hook scripts in remote mode (end-to-end hook invocation)
#
# Invokes the built hook scripts directly with CONTEXT_MANAGER_URL and
# CONTEXT_MANAGER_TOKEN set, then verifies that observations and prompts
# flow through to the server database and are queryable via MCP.
#
# This is the end-to-end proof that the hook code paths themselves work,
# not just that the server endpoints accept the payload format.
#
# Hook scripts are at /app/plugin/scripts/ (built by build:hooks in Dockerfile.e2e).
#
# Precondition: context-server is running (depends_on in docker-compose.e2e.yml).

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

HOOK_DIR="/app/plugin/scripts"

# Base URL for capture endpoints (strip /mcp suffix)
MCP_BASE="${MCP_URL%/mcp}"

TS=$(date +%s%N 2>/dev/null || date +%s)
HOOK_PROJECT="/data/projects/hook-remote-${TS}"
HOOK_SESSION="e2e-hook-${TS}"

info "Scenario 06: hook scripts in remote mode (hook -> server -> query)"
info "  MCP_BASE: ${MCP_BASE}"
info "  HOOK_PROJECT: ${HOOK_PROJECT}"
info "  HOOK_SESSION: ${HOOK_SESSION}"

# --- 06a: context-inject.js (SessionStart) creates session on remote server ---
info "06a: context-inject.js creates session on remote server"

SESSION_INPUT=$(printf '{"session_id":"%s","cwd":"%s"}' "$HOOK_SESSION" "$HOOK_PROJECT")

INJECT_RESPONSE=$(echo "$SESSION_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${HOOK_DIR}/context-inject.js" 2>/dev/null || echo '{}')

if echo "$INJECT_RESPONSE" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' > /dev/null 2>&1; then
  pass "06a: context-inject.js returned hookSpecificOutput in remote mode"
else
  fail "06a: context-inject.js did not return valid hookSpecificOutput: $(echo "$INJECT_RESPONSE" | head -3)"
fi

INJECT_CONTEXT=$(echo "$INJECT_RESPONSE" | jq -r '.hookSpecificOutput.additionalContext // ""')
assert_contains "$INJECT_CONTEXT" "remote mode" \
  "06a: status hint reports remote mode"

# --- 06b: capture-tool.js (PostToolUse) sends an Edit observation to the server ---
info "06b: capture-tool.js sends Edit observation to server"

TOOL_INPUT=$(printf '{
  "session_id": "%s",
  "cwd": "%s",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "%s/src/remote-hook-test.ts",
    "old_string": "",
    "new_string": "export function remoteHookCapture() { return true; }"
  },
  "tool_response": "ok"
}' "$HOOK_SESSION" "$HOOK_PROJECT" "$HOOK_PROJECT")

TOOL_RESPONSE=$(echo "$TOOL_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${HOOK_DIR}/capture-tool.js" 2>/dev/null || echo '{}')

TOOL_STATUS=$(echo "$TOOL_RESPONSE" | jq -r '.status // ""')
if [ "$TOOL_STATUS" = "captured" ]; then
  pass "06b: capture-tool.js returned status:captured"
else
  fail "06b: capture-tool.js returned unexpected response: $TOOL_RESPONSE"
fi

# --- 06c: Observation from hook is visible on server ---
info "06c: observation from hook is visible via context_search"

# Brief pause for the write to commit before querying
sleep 1

SEARCH_TEXT=$(mcp_text 'context_search' "{\"query\":\"remoteHookCapture\",\"project\":\"${HOOK_PROJECT}\"}")
# Two assertions: the token must appear AND the no-results message must be absent.
# context_search echoes the query in "No observations found matching 'X'" so a lone
# assert_contains would pass even when nothing was stored.
assert_contains "$SEARCH_TEXT" "remoteHookCapture" \
  "06c: hook-captured observation is visible via context_search"
assert_not_contains "$SEARCH_TEXT" "No observations found" \
  "06c: context_search returned real results, not a no-match message"

# --- 06d: capture-prompt.js (UserPromptSubmit) sends prompt to server ---
info "06d: capture-prompt.js sends user prompt to server"

PROMPT_INPUT=$(printf '{
  "session_id": "%s",
  "cwd": "%s",
  "prompt_number": 1,
  "prompt": "Test the remote hook capture pipeline end to end"
}' "$HOOK_SESSION" "$HOOK_PROJECT")

PROMPT_RESPONSE=$(echo "$PROMPT_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${HOOK_DIR}/capture-prompt.js" 2>/dev/null || echo '{}')

PROMPT_STATUS=$(echo "$PROMPT_RESPONSE" | jq -r '.status // ""')
if [ "$PROMPT_STATUS" = "captured" ]; then
  pass "06d: capture-prompt.js returned status:captured"
else
  fail "06d: capture-prompt.js returned unexpected response: $PROMPT_RESPONSE"
fi

# --- 06e: context-inject.js in remote mode does not touch local SQLite ---
info "06e: context-inject.js in remote mode leaves local DB untouched"

# If CONTEXT_MANAGER_DB is set to a temp path, the file should NOT be created
# in remote mode (storage is deferred to local mode only).
TEMP_DB="/tmp/e2e-remote-mode-check-${TS}.db"

echo "$SESSION_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  CONTEXT_MANAGER_DB="$TEMP_DB" \
  node "${HOOK_DIR}/context-inject.js" > /dev/null 2>&1 || true

if [ ! -f "$TEMP_DB" ]; then
  pass "06e: remote mode does not create a local SQLite file"
else
  fail "06e: remote mode unexpectedly created a local SQLite file at ${TEMP_DB}"
  rm -f "$TEMP_DB"
fi

# --- 06f: hooks abort loudly when URL is set but TOKEN is missing ---
info "06f: hooks abort when CONTEXT_MANAGER_URL set without TOKEN"

NO_TOKEN_RESPONSE=$(echo "$TOOL_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="" \
  node "${HOOK_DIR}/capture-tool.js" 2>/dev/null || echo '{}')

NO_TOKEN_STATUS=$(echo "$NO_TOKEN_RESPONSE" | jq -r '.status // ""')
if [ "$NO_TOKEN_STATUS" = "error" ]; then
  pass "06f: capture-tool.js returns status:error when TOKEN is missing"
else
  fail "06f: capture-tool.js returned unexpected response without TOKEN: $NO_TOKEN_RESPONSE"
fi

scenario_result "06-hook-remote-mode"
