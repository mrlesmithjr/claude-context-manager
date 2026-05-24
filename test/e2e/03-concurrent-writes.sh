#!/usr/bin/env bash
# Scenario 03: Concurrent SQLite writes (WAL mode integrity)
#
# Verifies that SQLite WAL mode keeps the DB readable and uncorrupted when two
# node processes write observations simultaneously. SQLITE_BUSY is normal under
# contention -- this test does not require both writers to succeed; it requires:
#   a) the DB to remain queryable after concurrent writes
#   b) the observation count to have increased (at least one writer succeeded)
#
# This does NOT test concurrent HTTP MCP capture (phases 4-7 of #1 are not yet
# implemented). It validates the underlying WAL concurrency the HTTP server
# relies on.

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

SCRIPT_DIR="$(dirname "$0")"

info "Scenario 03: concurrent SQLite writes (WAL integrity)"

# Get baseline observation count before concurrent writes
STATS_BEFORE=$(mcp_call 'context_stats' '{}' 2>/dev/null || echo '{}')
COUNT_BEFORE=$(echo "$STATS_BEFORE" \
  | jq -r '.result.content[0].text // ""' \
  | grep 'Total Observations:' \
  | grep -o '[0-9]*' | head -1 || echo 0)
info "03: baseline observation count before concurrent writes: ${COUNT_BEFORE}"

# --- 03a: launch two concurrent writers against separate project paths ---
# Use timestamp-based project paths so observations are never deduplicated
# by content_hash across runs, even on a stale volume.
info "03a: launching two concurrent writers (unique timestamp-based project paths)"

TS=$(date +%s%N 2>/dev/null || date +%s)
WRITER1_LOG=$(mktemp)
WRITER2_LOG=$(mktemp)

PROJECT_A="/data/projects/concurrent-${TS}-w1a" \
PROJECT_B="/data/projects/concurrent-${TS}-w1b" \
  node "${SCRIPT_DIR}/setup-data.mjs" \
  >"${WRITER1_LOG}" 2>&1 &
PID1=$!

PROJECT_A="/data/projects/concurrent-${TS}-w2a" \
PROJECT_B="/data/projects/concurrent-${TS}-w2b" \
  node "${SCRIPT_DIR}/setup-data.mjs" \
  >"${WRITER2_LOG}" 2>&1 &
PID2=$!

FAIL1=0
FAIL2=0
wait "$PID1" || FAIL1=1
wait "$PID2" || FAIL2=1

if [ "$FAIL1" -eq 0 ] && [ "$FAIL2" -eq 0 ]; then
  pass "03a: both concurrent writers exited successfully"
elif [ "$FAIL1" -eq 0 ] || [ "$FAIL2" -eq 0 ]; then
  pass "03a: at least one writer succeeded (SQLite BUSY on contention is expected)"
else
  fail "03a: both concurrent writers failed (at least one should succeed)"
  echo "  Writer 1 output:"; head -5 "${WRITER1_LOG}" | sed 's/^/    /'
  echo "  Writer 2 output:"; head -5 "${WRITER2_LOG}" | sed 's/^/    /'
fi

rm -f "${WRITER1_LOG}" "${WRITER2_LOG}"

# --- 03b: DB remains queryable after concurrent writes ---
info "03b: DB integrity check via HTTP MCP query"

sleep 1  # brief pause for WAL checkpoint to settle

QUERY_RESPONSE=$(mcp_call 'context_list' '{"project":"/data/projects","limit":5}' 2>/dev/null || echo '{}')
if echo "$QUERY_RESPONSE" | jq -e '.result' > /dev/null 2>&1; then
  pass "03b: DB remains queryable after concurrent writes"
else
  fail "03b: DB query failed after concurrent writes (possible corruption)"
  echo "$QUERY_RESPONSE" | head -5
fi

# --- 03c: observation count increased after concurrent writes ---
info "03c: observation count increased (at least one writer committed)"

STATS_AFTER=$(mcp_call 'context_stats' '{}' 2>/dev/null || echo '{}')
COUNT_AFTER=$(echo "$STATS_AFTER" \
  | jq -r '.result.content[0].text // ""' \
  | grep 'Total Observations:' \
  | grep -o '[0-9]*' | head -1 || echo 0)

info "03c: observation count after concurrent writes: ${COUNT_AFTER}"

if [ "$COUNT_AFTER" -gt "$COUNT_BEFORE" ] 2>/dev/null; then
  pass "03c: observation count increased from ${COUNT_BEFORE} to ${COUNT_AFTER}"
else
  fail "03c: observation count did not increase (${COUNT_BEFORE} -> ${COUNT_AFTER})"
fi

# --- 03d: stats endpoint still returns well-formed output ---
info "03d: context_stats still returns well-formed output"
STATS_TEXT=$(echo "$STATS_AFTER" | jq -r '.result.content[0].text // ""')
assert_contains "$STATS_TEXT" "Total Observations:" \
  "03d: stats output contains Total Observations after concurrent writes"

scenario_result "03-concurrent-writes"
