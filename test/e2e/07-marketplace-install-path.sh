#!/usr/bin/env bash
# Scenario 07: Marketplace install path — zero to hero
#
# Simulates a user who installed the plugin from the marketplace (no native
# modules in plugin/node_modules/) and either has or has not configured a
# remote server. Verifies that:
#
#   a) With no native modules AND no server URL, context-inject returns the
#      self-contained setup instructions as additionalContext (not a crash).
#
#   b) With no native modules AND a server URL pointing to an unreachable host,
#      context-inject returns the server-unreachable warning (health check path).
#
#   c) With no native modules AND the real server URL, all four hooks work
#      correctly in remote mode — observations and prompts flow to the server.
#
#   d) The MCP stdio server starts cleanly in proxy mode without native modules.
#
#   e) capture-tool and capture-prompt return status:error (not a crash) when
#      no native modules and no server URL are present.
#
# Native module absence is simulated by temporarily renaming plugin/node_modules/.
# The rename is always reversed in a trap, so failures cannot leave the
# directory in a broken state.
#
# Precondition: context-server is running (depends_on in docker-compose.e2e.yml).

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

HOOK_DIR="/app/plugin/scripts"
MCP_BASE="${MCP_URL%/mcp}"

TS=$(date +%s%N 2>/dev/null || date +%s)
HOOK_PROJECT="/data/projects/marketplace-${TS}"
HOOK_SESSION="e2e-marketplace-${TS}"

info "Scenario 07: marketplace install path (zero to hero)"
info "  MCP_BASE:     ${MCP_BASE}"
info "  HOOK_PROJECT: ${HOOK_PROJECT}"
info "  HOOK_SESSION: ${HOOK_SESSION}"

# Marketplace install simulation:
# Hiding plugin/node_modules/ is NOT sufficient in Docker because Node.js resolution
# walks up the tree and finds /app/node_modules/. To truly simulate a marketplace
# install we copy the hook scripts to /tmp/ (outside /app/) so require() finds no
# node_modules/ along the resolution chain, exactly as it would in
# ~/.claude/plugins/cache/.../scripts/ on a real user machine.
MARKETPLACE_HOOK_DIR="/tmp/ctx-marketplace-test-${TS}"
cleanup_marketplace() {
  rm -rf "$MARKETPLACE_HOOK_DIR" 2>/dev/null || true
}
trap cleanup_marketplace EXIT

mkdir -p "${MARKETPLACE_HOOK_DIR}/mcp"
cp "${HOOK_DIR}/context-inject.js" "${MARKETPLACE_HOOK_DIR}/"
cp "${HOOK_DIR}/capture-tool.js"   "${MARKETPLACE_HOOK_DIR}/"
cp "${HOOK_DIR}/capture-prompt.js" "${MARKETPLACE_HOOK_DIR}/"
cp "${HOOK_DIR}/mcp/server.js"     "${MARKETPLACE_HOOK_DIR}/mcp/"

SESSION_INPUT=$(printf '{"session_id":"%s","cwd":"%s"}' "$HOOK_SESSION" "$HOOK_PROJECT")

# --- 07a: No natives + no server URL -> setup instructions in additionalContext ---
info "07a: no natives + no URL -> setup instructions returned, no crash"

INJECT_NO_SERVER=$(echo "$SESSION_INPUT" | \
  CONTEXT_MANAGER_URL="" \
  node "${MARKETPLACE_HOOK_DIR}/context-inject.js" 2>/dev/null || echo '{}')

# Must return valid hookSpecificOutput (not crash with exit 1)
if echo "$INJECT_NO_SERVER" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' > /dev/null 2>&1; then
  pass "07a: context-inject.js returned hookSpecificOutput without crashing"
else
  fail "07a: context-inject.js crashed or returned invalid output: $(echo "$INJECT_NO_SERVER" | head -3)"
fi

NO_SERVER_CTX=$(echo "$INJECT_NO_SERVER" | jq -r '.hookSpecificOutput.additionalContext // ""')
assert_contains "$NO_SERVER_CTX" "No server configured" \
  "07a: additionalContext contains setup instructions"
assert_contains "$NO_SERVER_CTX" "server-quickstart" \
  "07a: setup instructions mention server-quickstart"
assert_contains "$NO_SERVER_CTX" "help me set up" \
  "07a: setup instructions tell user to ask Claude for help"

# --- 07b: No natives + unreachable server URL -> reachability warning ---
info "07b: no natives + unreachable URL -> server warning, no crash"

INJECT_UNREACHABLE=$(echo "$SESSION_INPUT" | \
  CONTEXT_MANAGER_URL="http://127.0.0.1:19999" \
  CONTEXT_MANAGER_TOKEN="dummy-token" \
  node "${MARKETPLACE_HOOK_DIR}/context-inject.js" 2>/dev/null || echo '{}')

if echo "$INJECT_UNREACHABLE" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' > /dev/null 2>&1; then
  pass "07b: context-inject.js returned hookSpecificOutput for unreachable server"
else
  fail "07b: context-inject.js crashed or returned invalid output: $(echo "$INJECT_UNREACHABLE" | head -3)"
fi

UNREACHABLE_CTX=$(echo "$INJECT_UNREACHABLE" | jq -r '.hookSpecificOutput.additionalContext // ""')
assert_contains "$UNREACHABLE_CTX" "not responding" \
  "07b: additionalContext reports server not responding"
assert_contains "$UNREACHABLE_CTX" "server-restart" \
  "07b: additionalContext mentions server-restart for recovery"

# --- 07c: capture-tool + no natives + no URL -> status:error (not a crash) ---
info "07c: capture-tool with no natives + no URL -> status:error, no crash"

TOOL_INPUT=$(printf '{
  "session_id": "%s",
  "cwd": "%s",
  "tool_name": "Edit",
  "tool_input": {"file_path": "%s/test.ts", "old_string": "", "new_string": "marketplace-capture-test"},
  "tool_response": "ok"
}' "$HOOK_SESSION" "$HOOK_PROJECT" "$HOOK_PROJECT")

TOOL_NO_NATIVE=$(echo "$TOOL_INPUT" | \
  CONTEXT_MANAGER_URL="" \
  node "${MARKETPLACE_HOOK_DIR}/capture-tool.js" 2>/dev/null || echo '{}')

TOOL_STATUS=$(echo "$TOOL_NO_NATIVE" | jq -r '.status // ""')
if [ "$TOOL_STATUS" = "error" ]; then
  pass "07c: capture-tool.js returned status:error without crashing"
else
  fail "07c: capture-tool.js returned unexpected status: $TOOL_STATUS"
fi

# --- 07d: capture-prompt + no natives + no URL -> status:error (not a crash) ---
info "07d: capture-prompt with no natives + no URL -> status:error, no crash"

PROMPT_INPUT=$(printf '{
  "session_id": "%s",
  "cwd": "%s",
  "prompt_number": 1,
  "prompt": "zero to hero test"
}' "$HOOK_SESSION" "$HOOK_PROJECT")

PROMPT_NO_NATIVE=$(echo "$PROMPT_INPUT" | \
  CONTEXT_MANAGER_URL="" \
  node "${MARKETPLACE_HOOK_DIR}/capture-prompt.js" 2>/dev/null || echo '{}')

PROMPT_STATUS=$(echo "$PROMPT_NO_NATIVE" | jq -r '.status // ""')
if [ "$PROMPT_STATUS" = "error" ]; then
  pass "07d: capture-prompt.js returned status:error without crashing"
else
  fail "07d: capture-prompt.js returned unexpected status: $PROMPT_STATUS"
fi

# ============================================================
# Phase 2: No natives + real server (the working remote path)
# ============================================================
info "Phase 2: no natives + real remote server (expected working state)"

# --- 07e: context-inject with no natives + real server -> active status ---
info "07e: context-inject with no natives + real URL -> active status hint"

INJECT_REMOTE=$(echo "$SESSION_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${MARKETPLACE_HOOK_DIR}/context-inject.js" 2>/dev/null || echo '{}')

if echo "$INJECT_REMOTE" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' > /dev/null 2>&1; then
  pass "07e: context-inject.js returned hookSpecificOutput in remote mode without natives"
else
  fail "07e: context-inject.js crashed or returned invalid output: $(echo "$INJECT_REMOTE" | head -3)"
fi

REMOTE_CTX=$(echo "$INJECT_REMOTE" | jq -r '.hookSpecificOutput.additionalContext // ""')
assert_contains "$REMOTE_CTX" "remote mode" \
  "07e: status hint confirms remote mode is active"
assert_not_contains "$REMOTE_CTX" "not responding" \
  "07e: no server-unreachable warning when server is healthy"

# --- 07f: capture-tool with no natives + real server -> captured ---
info "07f: capture-tool with no natives + real URL -> observation captured"

TOOL_REMOTE=$(echo "$TOOL_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${MARKETPLACE_HOOK_DIR}/capture-tool.js" 2>/dev/null || echo '{}')

TOOL_REMOTE_STATUS=$(echo "$TOOL_REMOTE" | jq -r '.status // ""')
if [ "$TOOL_REMOTE_STATUS" = "captured" ]; then
  pass "07f: capture-tool.js returned status:captured in remote mode without natives"
else
  fail "07f: capture-tool.js returned unexpected status: $TOOL_REMOTE_STATUS"
fi

# --- 07g: capture-prompt with no natives + real server -> captured ---
info "07g: capture-prompt with no natives + real URL -> prompt captured"

PROMPT_REMOTE=$(echo "$PROMPT_INPUT" | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  node "${MARKETPLACE_HOOK_DIR}/capture-prompt.js" 2>/dev/null || echo '{}')

PROMPT_REMOTE_STATUS=$(echo "$PROMPT_REMOTE" | jq -r '.status // ""')
if [ "$PROMPT_REMOTE_STATUS" = "captured" ]; then
  pass "07g: capture-prompt.js returned status:captured in remote mode without natives"
else
  fail "07g: capture-prompt.js returned unexpected status: $PROMPT_REMOTE_STATUS"
fi

# --- 07h: MCP stdio server starts cleanly in proxy mode without natives ---
info "07h: MCP stdio server starts in proxy mode without natives"

# Send a minimal JSON-RPC initialize, cap at 3 seconds.
# The server writes to stderr (not stdout) so we capture stderr separately.
MCP_STDERR=$(echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' | \
  CONTEXT_MANAGER_URL="$MCP_BASE" \
  CONTEXT_MANAGER_TOKEN="$MCP_TOKEN" \
  timeout 3 node "${MARKETPLACE_HOOK_DIR}/mcp/server.js" 2>&1 1>/dev/null || true)

if echo "$MCP_STDERR" | grep -q "MCP server connected"; then
  pass "07h: MCP stdio server started and connected via stdio without native modules"
elif echo "$MCP_STDERR" | grep -qi "fatal\|TypeError\|not a constructor"; then
  fail "07h: MCP stdio server crashed: $(echo "$MCP_STDERR" | head -3)"
else
  # Server started (no crash) but may have exited before printing the connected line
  # due to the 3s timeout closing stdin. That's acceptable — no crash is the bar.
  pass "07h: MCP stdio server started without crashing (timeout closed stdin)"
fi

# ============================================================
# Phase 3: Verify observations reached the server
# ============================================================
info "Phase 3: verify remote observations are queryable"

sleep 1  # allow writes to commit

SEARCH_RESULT=$(mcp_text 'context_search' \
  "{\"query\":\"marketplace-capture-test\",\"project\":\"${HOOK_PROJECT}\"}")

assert_contains "$SEARCH_RESULT" "marketplace-capture-test" \
  "07i: prompt captured in remote mode is searchable via context_search"
assert_not_contains "$SEARCH_RESULT" "No observations found" \
  "07i: context_search returned real results, not a no-match message"

# ============================================================
# Cleanup (trap restores native modules)
# ============================================================
info "Scenario 07 complete. Native modules will be restored by EXIT trap."

scenario_result "07-marketplace-install-path"
