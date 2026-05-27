#!/usr/bin/env bash
# Scenario 08: context_list token budget enforcement (v0.8.96)
#
# Verifies that context_list respects CONTEXT_MANAGER_TOKEN_BUDGET:
#   a) When total session tokens exceed the budget, output is truncated at a
#      session boundary and a footer is appended.
#   b) The truncation footer includes the session counts and a hint to use
#      context_search.
#   c) context_stats reports a budget_fill_tokens value that is > 0 and
#      <= TOKEN_BUDGET for the budget project.
#
# Precondition: setup-data.mjs has seeded PROJECT_BUDGET with 4 sessions
# totalling ~3600 tokens. The default TOKEN_BUDGET=4000 gives effectiveBudget=3200,
# so sessions 1-3 (2700 tokens) fit but adding session 4 (900 tokens) would exceed
# the limit — triggering truncation after 3 sessions.

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

PROJECT_BUDGET="${PROJECT_BUDGET:-/data/budget-tests/project-budget}"
TOKEN_BUDGET="${CONTEXT_MANAGER_TOKEN_BUDGET:-4000}"

info "Scenario 08: context_list token budget enforcement"

# --- 08a: context_list with a full project returns a truncation footer ---
info "08a: context_list emits truncation footer when sessions exceed budget"
LIST_TEXT=$(mcp_text 'context_list' "{\"project\":\"${PROJECT_BUDGET}\",\"limit\":20}")

assert_contains "$LIST_TEXT" "Budget:" \
  "08a: context_list output contains Budget truncation footer"

# --- 08b: footer mentions session counts (N of M sessions) ---
info "08b: truncation footer contains session count phrase"
assert_contains "$LIST_TEXT" "sessions" \
  "08b: truncation footer includes the word 'sessions'"

# --- 08c: footer directs user to context_search ---
info "08c: truncation footer mentions context_search"
assert_contains "$LIST_TEXT" "context_search" \
  "08c: truncation footer mentions context_search for full history"

# --- 08d: context_stats reports budget_fill_tokens > 0 for the project ---
info "08d: context_stats shows Budget Fill > 0"
STATS_TEXT=$(mcp_text 'context_stats' "{\"project\":\"${PROJECT_BUDGET}\"}")

assert_contains "$STATS_TEXT" "Budget Fill" \
  "08d: context_stats Token Economics section includes Budget Fill line"

BUDGET_FILL=$(echo "$STATS_TEXT" | grep 'Budget Fill' | grep -o '[0-9]*' | head -1 || echo 0)
if [ "${BUDGET_FILL:-0}" -gt 0 ] 2>/dev/null; then
  pass "08d: Budget Fill tokens > 0 (got ${BUDGET_FILL})"
else
  fail "08d: expected Budget Fill > 0, got '${BUDGET_FILL}' — check that getWithinBudget() is wired into getStats()"
fi

# --- 08e: budget_fill_tokens does not exceed TOKEN_BUDGET ---
info "08e: Budget Fill does not exceed TOKEN_BUDGET (${TOKEN_BUDGET})"
if [ "${BUDGET_FILL:-0}" -le "${TOKEN_BUDGET}" ] 2>/dev/null; then
  pass "08e: Budget Fill (${BUDGET_FILL}) <= TOKEN_BUDGET (${TOKEN_BUDGET})"
else
  fail "08e: Budget Fill (${BUDGET_FILL}) exceeds TOKEN_BUDGET (${TOKEN_BUDGET})"
fi

scenario_result "08-budget-enforcement"
