#!/usr/bin/env bash
# Scenario 09: Auto-write lessons at session end (local mode only)
#
# Invokes session-end.js in local mode with HOME overridden to a temp dir.
# Seeds a SQLite DB directly with skill-attributed observations, then verifies
# that .lessons.md sidecar files are created with the correct content and format.
#
# Local mode is required: writeSessionLessons() is only called when
# CONTEXT_MANAGER_URL is NOT set. We never set that var in this scenario.
#
# Key env overrides used throughout:
#   HOME          - Points to TEMP_HOME; homedir() uses this, so SQLiteStorage opens
#                   $TEMP_HOME/.claude-context/context.db (the constructor default)
#                   and lesson files write to $TEMP_HOME/.dotfiles/...
#   CONTEXT_MANAGER_URL - Explicitly unset to guarantee local mode
#
# Precondition: /app/dist/ contains compiled TypeScript (tsc output).
#               /app/plugin/scripts/ contains hook bundles (esbuild output).
#               better-sqlite3 is available at /app/node_modules/.

# shellcheck source=helpers.sh
source "$(dirname "$0")/helpers.sh"

HOOK_DIR="/app/plugin/scripts"

TS=$(date +%s%N 2>/dev/null || date +%s)
TEMP_HOME="/tmp/e2e-lessons-home-${TS}"
# SQLiteStorage constructor uses DEFAULT_DB_PATH = homedir()/.claude-context/context.db
# with no env var fallback, so seed directly into that path.
TEST_DB="${TEMP_HOME}/.claude-context/context.db"
# Use a cwd under TEMP_HOME; homedir() === TEMP_HOME at runtime so this is in ALLOWED_PROJECT_ROOTS
HOOK_PROJECT="${TEMP_HOME}/projects/test-lessons"
HOOK_SESSION="e2e-lessons-session-${TS}"
TODAY=$(date +%Y-%m-%d)

info "Scenario 09: auto-write lessons at session end (local mode)"
info "  TEMP_HOME:    ${TEMP_HOME}"
info "  TEST_DB:      ${TEST_DB}"
info "  HOOK_PROJECT: ${HOOK_PROJECT}"
info "  HOOK_SESSION: ${HOOK_SESSION}"
info "  TODAY:        ${TODAY}"

# Always clean up the temp home dir, even on failure
cleanup_temp_home() {
  rm -rf "$TEMP_HOME" 2>/dev/null || true
}
trap cleanup_temp_home EXIT

# Create directory layout
mkdir -p "${TEMP_HOME}/projects/test-lessons"
mkdir -p "${TEMP_HOME}/.dotfiles/.claude/agents"
mkdir -p "${TEMP_HOME}/.dotfiles/.claude/skills"

# --- Seed the DB with a session and three skill-attributed observations ---
# We use the tsc-compiled dist/ output directly (not the esbuild bundle) because
# we are importing SQLiteStorage as a module, not running a standalone hook script.
HOME="$TEMP_HOME" node --input-type=module <<EOF
import { SQLiteStorage } from '/app/dist/storage/sqlite.js';

// Seed directly into the default path: homedir()/.claude-context/context.db
// This matches what session-end.js opens (constructor default, no env var fallback).
const storage = new SQLiteStorage();
await storage.initialize();

// Create the session first
await storage.createSession(
  '${HOOK_SESSION}',
  '${HOOK_PROJECT}',
  null // branch
);

// Observation 1: Agent invocation with high importance (triggers agent lesson)
await storage.save({
  session_id: '${HOOK_SESSION}',
  project: '${HOOK_PROJECT}',
  tool_name: 'Agent',
  summary: 'e2e-agent found the root cause in src/storage/sqlite.ts at line 1901',
  files_touched: [],
  metadata: {},
  token_estimate: 20,
  importance: 'high',
  importance_score: 0.8,
  skill: 'e2e-test-agent',
  lesson_type: null,
  branch: null,
  created_at: new Date().toISOString(),
});

// Observation 2: Skill invocation with importance >= 0.5 (triggers skill lesson)
await storage.save({
  session_id: '${HOOK_SESSION}',
  project: '${HOOK_PROJECT}',
  tool_name: 'Skill',
  summary: 'e2e-skill ran and succeeded on first try',
  files_touched: [],
  metadata: {},
  token_estimate: 15,
  importance: 'medium',
  importance_score: 0.6,
  skill: 'e2e-test-skill',
  lesson_type: null,
  branch: null,
  created_at: new Date().toISOString(),
});

// Observation 3: Build failure attributed to same skill (has lesson_type, so threshold is met)
await storage.save({
  session_id: '${HOOK_SESSION}',
  project: '${HOOK_PROJECT}',
  tool_name: 'Bash',
  summary: 'npm run build failed: cannot find module src/utils/lessons.js',
  files_touched: [],
  metadata: {},
  token_estimate: 18,
  importance: 'medium',
  importance_score: 0.55,
  skill: 'e2e-test-skill',
  lesson_type: 'build_failure',
  branch: null,
  created_at: new Date().toISOString(),
});

await storage.close();
console.log('DB seeded successfully');
EOF

SEED_EXIT=$?
if [ $SEED_EXIT -ne 0 ]; then
  fail "09 setup: DB seeding failed with exit code ${SEED_EXIT}"
  scenario_result "09-auto-write-lessons"
fi

info "DB seeded into default path (${TEST_DB}), invoking session-end.js in local mode..."

# --- 09a: session-end.js returns status:complete ---
info "09a: session-end.js returns {\"status\":\"complete\"} in local mode"

STOP_INPUT=$(printf '{"session_id":"%s","cwd":"%s"}' "$HOOK_SESSION" "$HOOK_PROJECT")

HOOK_STDERR=$(mktemp)
STOP_RESPONSE=$(echo "$STOP_INPUT" | \
  HOME="$TEMP_HOME" \
  CONTEXT_MANAGER_URL="" \
  node "${HOOK_DIR}/session-end.js" 2>"$HOOK_STDERR" || echo '{}')
HOOK_STDERR_CONTENT=$(cat "$HOOK_STDERR")
rm -f "$HOOK_STDERR"
info "Hook stderr: ${HOOK_STDERR_CONTENT}"

STOP_STATUS=$(echo "$STOP_RESPONSE" | jq -r '.status // ""')
if [ "$STOP_STATUS" = "complete" ]; then
  pass "09a: session-end.js returned status:complete"
else
  fail "09a: session-end.js returned unexpected response: ${STOP_RESPONSE}"
fi

# Paths the hook should have written to (resolved via TEMP_HOME)
AGENT_LESSONS="${TEMP_HOME}/.dotfiles/.claude/agents/e2e-test-agent.lessons.md"
SKILL_LESSONS="${TEMP_HOME}/.dotfiles/.claude/skills/e2e-test-skill/.lessons.md"

# --- 09b: Agent lesson file exists ---
info "09b: agent lesson file exists at expected path"
if [ -f "$AGENT_LESSONS" ]; then
  pass "09b: agent lesson file exists at ${AGENT_LESSONS}"
else
  fail "09b: agent lesson file not found at ${AGENT_LESSONS}"
fi

# --- 09c: Agent lesson file has today's date heading ---
info "09c: agent lesson file has today's date heading"
AGENT_CONTENT=$(cat "$AGENT_LESSONS" 2>/dev/null || echo '')
assert_contains "$AGENT_CONTENT" "## ${TODAY}" \
  "09c: agent lesson file has date heading ## ${TODAY}"

# --- 09d: Agent lesson file contains the observation summary text ---
info "09d: agent lesson file contains observation summary"
assert_contains "$AGENT_CONTENT" "e2e-agent found the root cause in src/storage/sqlite.ts at line 1901" \
  "09d: agent lesson file contains the observation summary text"

# --- 09e: Skill lesson file exists ---
info "09e: skill lesson file exists at expected path"
if [ -f "$SKILL_LESSONS" ]; then
  pass "09e: skill lesson file exists at ${SKILL_LESSONS}"
else
  fail "09e: skill lesson file not found at ${SKILL_LESSONS}"
fi

# --- 09f: Skill lesson file has today's date heading ---
info "09f: skill lesson file has today's date heading"
SKILL_CONTENT=$(cat "$SKILL_LESSONS" 2>/dev/null || echo '')
assert_contains "$SKILL_CONTENT" "## ${TODAY}" \
  "09f: skill lesson file has date heading ## ${TODAY}"

# --- 09g: Skill lesson file has [build_failure] prefixed entry ---
info "09g: skill lesson file contains [build_failure] prefixed entry"
assert_contains "$SKILL_CONTENT" "[build_failure]" \
  "09g: skill lesson file contains [build_failure] prefix for lesson_type observation"

# --- 09h: Both lesson files have the MCP header line ---
info "09h: both lesson files contain the MCP tool header"
assert_contains "$AGENT_CONTENT" "context_agent_lessons" \
  "09h: agent lesson file contains context_agent_lessons header"
assert_contains "$SKILL_CONTENT" "context_skill_lessons" \
  "09h: skill lesson file contains context_skill_lessons header"

# --- 09i: Second invocation on same session + same date does not duplicate the date heading ---
info "09i: re-running session-end.js on same session+date appends, not duplicates"

STOP_RESPONSE2=$(echo "$STOP_INPUT" | \
  HOME="$TEMP_HOME" \
  CONTEXT_MANAGER_URL="" \
  node "${HOOK_DIR}/session-end.js" 2>/dev/null || echo '{}')

STOP_STATUS2=$(echo "$STOP_RESPONSE2" | jq -r '.status // ""')
if [ "$STOP_STATUS2" != "complete" ]; then
  fail "09i: second session-end invocation returned unexpected status: ${STOP_RESPONSE2}"
else
  # Count how many times today's heading appears in the agent file after re-run
  AGENT_CONTENT2=$(cat "$AGENT_LESSONS" 2>/dev/null || echo '')
  HEADING_COUNT=$(echo "$AGENT_CONTENT2" | grep -cF "## ${TODAY}" || echo 0)
  if [ "$HEADING_COUNT" -eq 1 ]; then
    pass "09i: date heading appears exactly once after second invocation (no duplicate)"
  else
    fail "09i: expected exactly 1 date heading, found ${HEADING_COUNT} in agent lesson file"
    echo "  Agent lesson file content after second run:"
    echo "$AGENT_CONTENT2" | head -30 | sed 's/^/    /'
  fi
fi

# Cleanup handled by EXIT trap
scenario_result "09-auto-write-lessons"
