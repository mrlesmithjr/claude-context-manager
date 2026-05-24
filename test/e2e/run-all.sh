#!/usr/bin/env bash
# E2E test orchestrator.
#
# Invoked by the test-runner container in docker-compose.e2e.yml.
# Runs all scenario scripts and aggregates results.
#
# Exit codes:
#   0  all scenarios passed
#   1  one or more scenarios failed
#
# Environment (set by docker-compose.e2e.yml):
#   MCP_URL              HTTP MCP endpoint
#   MCP_TOKEN            Bearer token
#   CONTEXT_MANAGER_DB   SQLite DB path (shared volume)
#   PROJECT_A            Test project A path
#   PROJECT_B            Test project B path

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure all scripts are executable
chmod +x "${SCRIPT_DIR}"/*.sh

# --- Greeting ---
echo "============================================"
echo " context-manager E2E Test Suite"
echo "============================================"
echo " MCP_URL : ${MCP_URL:-<not set>}"
echo " DB      : ${CONTEXT_MANAGER_DB:-<not set>}"
echo " PROJECT_A: ${PROJECT_A:-<not set>}"
echo " PROJECT_B: ${PROJECT_B:-<not set>}"
echo ""

# --- Phase 1: Insert test data into shared DB ---
echo "[run-all] Phase 1: Setting up test data..."
node "${SCRIPT_DIR}/setup-data.mjs"
echo ""

# --- Phase 2: Run scenarios ---
echo "[run-all] Phase 2: Running scenarios..."
echo ""

TOTAL_SCENARIOS=0
PASSED_SCENARIOS=0
FAILED_SCENARIOS=()

run_scenario() {
  local script="$1"
  local name
  name="$(basename "$script" .sh)"

  TOTAL_SCENARIOS=$((TOTAL_SCENARIOS + 1))
  echo "--------------------------------------------"
  echo " Running: ${name}"
  echo "--------------------------------------------"

  if bash "$script"; then
    PASSED_SCENARIOS=$((PASSED_SCENARIOS + 1))
  else
    FAILED_SCENARIOS+=("$name")
  fi
  echo ""
}

run_scenario "${SCRIPT_DIR}/01-basic-query.sh"
run_scenario "${SCRIPT_DIR}/02-cross-project.sh"
run_scenario "${SCRIPT_DIR}/03-concurrent-writes.sh"
run_scenario "${SCRIPT_DIR}/04-stats.sh"
run_scenario "${SCRIPT_DIR}/05-remote-capture.sh"

# --- Phase 3: Summary ---
echo "============================================"
echo " E2E Test Summary"
echo "============================================"
echo " Total scenarios : ${TOTAL_SCENARIOS}"
echo " Passed          : ${PASSED_SCENARIOS}"
echo " Failed          : $((TOTAL_SCENARIOS - PASSED_SCENARIOS))"

if [ "${#FAILED_SCENARIOS[@]}" -gt 0 ]; then
  echo ""
  echo " Failed scenarios:"
  for s in "${FAILED_SCENARIOS[@]}"; do
    echo "   - ${s}"
  done
  echo ""
  echo "[run-all] FAIL - one or more scenarios failed"
  exit 1
else
  echo ""
  echo "[run-all] PASS - all scenarios passed"
  exit 0
fi
