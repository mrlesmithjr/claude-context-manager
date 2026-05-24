#!/usr/bin/env bash
# Scenario 04: context_stats correctness
#
# Verifies that context_stats returns well-formed output with expected
# observation and session counts for the test data inserted by setup-data.mjs.
#
# Precondition: setup-data.mjs has already run (called by run-all.sh).

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

PROJECT_A="${PROJECT_A:-/data/projects/project-a}"
PROJECT_B="${PROJECT_B:-/data/projects/project-b}"

info "Scenario 04: context_stats output correctness"

# --- 04a: global stats show at least 8 total observations ---
info "04a: global stats (all projects) have expected observation count"
GLOBAL_TEXT=$(mcp_text 'context_stats' '{}')

assert_contains "$GLOBAL_TEXT" "Total Observations:" \
  "04a: global stats include Total Observations line"

GLOBAL_OBS=$(echo "$GLOBAL_TEXT" | grep 'Total Observations:' | grep -o '[0-9]*' | head -1 || echo 0)
if [ "$GLOBAL_OBS" -ge 8 ] 2>/dev/null; then
  pass "04a: global observation count >= 8 (got ${GLOBAL_OBS})"
else
  fail "04a: expected global observation count >= 8, got ${GLOBAL_OBS}"
fi

# --- 04b: project-a stats show at least 5 observations ---
info "04b: project-a stats show at least 5 observations"
A_TEXT=$(mcp_text 'context_stats' "{\"project\":\"${PROJECT_A}\"}")

A_OBS=$(echo "$A_TEXT" | grep 'Total Observations:' | grep -o '[0-9]*' | head -1 || echo 0)
if [ "$A_OBS" -ge 5 ] 2>/dev/null; then
  pass "04b: project-a observation count >= 5 (got ${A_OBS})"
else
  fail "04b: expected project-a observation count >= 5, got ${A_OBS}"
fi

# --- 04c: project-b stats show at least 3 observations ---
info "04c: project-b stats show at least 3 observations"
B_TEXT=$(mcp_text 'context_stats' "{\"project\":\"${PROJECT_B}\"}")

B_OBS=$(echo "$B_TEXT" | grep 'Total Observations:' | grep -o '[0-9]*' | head -1 || echo 0)
if [ "$B_OBS" -ge 3 ] 2>/dev/null; then
  pass "04c: project-b observation count >= 3 (got ${B_OBS})"
else
  fail "04c: expected project-b observation count >= 3, got ${B_OBS}"
fi

# --- 04d: project-a session count is at least 1 ---
info "04d: project-a has at least 1 session"
assert_contains "$A_TEXT" "Total Sessions:" \
  "04d: project-a stats include Total Sessions line"

A_SESSIONS=$(echo "$A_TEXT" | grep 'Total Sessions:' | grep -o '[0-9]*' | head -1 || echo 0)
if [ "$A_SESSIONS" -ge 1 ] 2>/dev/null; then
  pass "04d: project-a session count >= 1 (got ${A_SESSIONS})"
else
  fail "04d: expected project-a session count >= 1, got ${A_SESSIONS}"
fi

# --- 04e: stats text includes importance distribution section ---
info "04e: stats include importance distribution section"
assert_contains "$A_TEXT" "Importance Distribution" \
  "04e: project-a stats include Importance Distribution section"

# --- 04f: project-a has high-importance observations (2 inserted) ---
info "04f: project-a high-importance count is at least 2"
HIGH_LINE=$(echo "$A_TEXT" | grep -i 'High:' || echo "")
if [ -n "$HIGH_LINE" ]; then
  HIGH_COUNT=$(echo "$HIGH_LINE" | grep -o '[0-9]*' | head -1 || echo 0)
  if [ "$HIGH_COUNT" -ge 2 ] 2>/dev/null; then
    pass "04f: project-a high-importance count >= 2 (got ${HIGH_COUNT})"
  else
    fail "04f: expected project-a high-importance count >= 2, got ${HIGH_COUNT}"
  fi
else
  fail "04f: project-a stats missing High importance line"
fi

# --- 04g: token economics section present ---
info "04g: stats include Token Economics section"
assert_contains "$A_TEXT" "Token Economics" \
  "04g: project-a stats include Token Economics section"

scenario_result "04-stats"
