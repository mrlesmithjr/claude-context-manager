#!/usr/bin/env bash
# Shared helpers for E2E test scenarios.
# Source this file at the top of each scenario script.
#
# Required environment variables (set by docker-compose.e2e.yml):
#   MCP_URL    HTTP MCP endpoint (e.g., http://context-server:4000/mcp)
#   MCP_TOKEN  Bearer token for auth

set -euo pipefail

# --- Color output (best-effort; no-op if not a tty) ---
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' RESET=''
fi

E2E_PASS=0
E2E_FAIL=0

# Pass counter helpers - used by run-all.sh to aggregate across scenarios
pass() { echo -e "${GREEN}PASS${RESET}: $1"; E2E_PASS=$((E2E_PASS + 1)); }
fail() { echo -e "${RED}FAIL${RESET}: $1"; E2E_FAIL=$((E2E_FAIL + 1)); }
info() { echo -e "${YELLOW}INFO${RESET}: $1"; }

# ---
# mcp_call <tool_name> <arguments_json>
#
# Makes a single MCP tools/call request to the HTTP server.
# Prints the full JSON-RPC response to stdout.
# Returns non-zero if curl fails or the HTTP status is not 200.
# ---
mcp_call() {
  local tool_name="$1"
  local args_json="${2:-{\}}"
  local request_id
  request_id="e2e-$(date +%s%N 2>/dev/null || date +%s)-$$"

  # StreamableHTTPServerTransport requires the client to accept both JSON and SSE
  # even when the server is configured with enableJsonResponse: true.
  curl -sf \
    -X POST "${MCP_URL}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer ${MCP_TOKEN}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"${tool_name}\",\"arguments\":${args_json}},\"id\":\"${request_id}\"}"
}

# ---
# mcp_text <tool_name> <arguments_json>
#
# Like mcp_call but extracts and prints only the text content from the result.
# ---
mcp_text() {
  mcp_call "$1" "$2" | jq -r '.result.content[0].text // empty'
}

# ---
# assert_contains <subject_string> <expected_substring> <label>
#
# Passes if expected_substring appears anywhere in subject_string.
# ---
assert_contains() {
  local subject="$1"
  local expected="$2"
  local label="$3"

  if echo "$subject" | grep -qF "$expected"; then
    pass "$label"
  else
    fail "$label (expected substring not found: '$expected')"
    echo "  Subject was:"
    echo "$subject" | head -10 | sed 's/^/    /'
  fi
}

# ---
# assert_not_contains <subject_string> <unexpected_substring> <label>
#
# Passes if unexpected_substring does NOT appear in subject_string.
# ---
assert_not_contains() {
  local subject="$1"
  local unexpected="$2"
  local label="$3"

  if echo "$subject" | grep -qF "$unexpected"; then
    fail "$label (unexpected substring found: '$unexpected')"
    echo "  Subject was:"
    echo "$subject" | head -10 | sed 's/^/    /'
  else
    pass "$label"
  fi
}

# ---
# assert_json_num <json_string> <jq_path> <expected_num> <label>
#
# Parses json_string with jq, extracts the numeric value at jq_path,
# and asserts it equals expected_num.
# ---
assert_json_num() {
  local json="$1"
  local path="$2"
  local expected="$3"
  local label="$4"

  local actual
  actual=$(echo "$json" | jq -r "$path // -1")

  if [ "$actual" -eq "$expected" ] 2>/dev/null; then
    pass "$label (got $actual)"
  else
    fail "$label (expected $expected, got $actual)"
  fi
}

# ---
# assert_json_gte <json_string> <jq_path> <min_num> <label>
#
# Asserts the extracted number is >= min_num.
# ---
assert_json_gte() {
  local json="$1"
  local path="$2"
  local min="$3"
  local label="$4"

  local actual
  actual=$(echo "$json" | jq -r "$path // -1")

  if [ "$actual" -ge "$min" ] 2>/dev/null; then
    pass "$label (got $actual >= $min)"
  else
    fail "$label (expected >= $min, got $actual)"
  fi
}

# ---
# scenario_result
#
# Print a summary line for the current scenario and exit with the appropriate code.
# Call at the end of each scenario script.
# ---
scenario_result() {
  local scenario_name="${1:-scenario}"
  local total=$((E2E_PASS + E2E_FAIL))

  if [ "$E2E_FAIL" -eq 0 ]; then
    echo -e "\n${GREEN}[SCENARIO ${scenario_name}] All ${total} assertions passed.${RESET}"
    exit 0
  else
    echo -e "\n${RED}[SCENARIO ${scenario_name}] ${E2E_FAIL}/${total} assertions FAILED.${RESET}"
    exit 1
  fi
}
