#!/usr/bin/env bash
# server-env.sh — Set up environment variables for context-manager remote mode.
#
# Run this ONCE after `make server-init` generates the token.
# It prints the commands needed to expose CONTEXT_MANAGER_URL and
# CONTEXT_MANAGER_TOKEN to Claude Code hooks.
#
# Two approaches are printed — use whichever matches how you launch Claude Code:
#   .zshrc  — works when Claude Code is launched from a terminal
#   launchctl — works when Claude Code is launched from the macOS Dock/Spotlight

set -euo pipefail

ENV_FILE="${HOME}/.claude-context/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Run 'make server-init' first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${CONTEXT_MANAGER_URL:-}" ] || [ -z "${CONTEXT_MANAGER_TOKEN:-}" ]; then
  echo "ERROR: CONTEXT_MANAGER_URL or CONTEXT_MANAGER_TOKEN missing from ${ENV_FILE}" >&2
  exit 1
fi

TOKEN="${CONTEXT_MANAGER_TOKEN}"
URL="${CONTEXT_MANAGER_URL}"

echo ""
echo "================================================================"
echo " context-manager remote mode — environment setup"
echo "================================================================"
echo ""
echo "Token and URL are stored in: ${ENV_FILE}"
echo ""
echo "Choose ONE of the following approaches based on how you launch Claude Code:"
echo ""
echo "--- Option A: terminal launch (Claude Code opened via 'claude' CLI) ---"
echo ""
echo "Add these lines to your ~/.zshrc (or ~/.bashrc):"
echo ""
echo "  export CONTEXT_MANAGER_URL=${URL}"
echo "  export CONTEXT_MANAGER_TOKEN=${TOKEN}"
echo ""
echo "Then reload your shell:  source ~/.zshrc"
echo ""
echo "--- Option B: Dock/Spotlight launch (Claude Code desktop app) ---"
echo ""
echo "Run these launchctl commands (they take effect immediately for new processes):"
echo ""
echo "  launchctl setenv CONTEXT_MANAGER_URL ${URL}"
echo "  launchctl setenv CONTEXT_MANAGER_TOKEN ${TOKEN}"
echo ""
echo "Then QUIT and relaunch Claude Code from the Dock."
echo "NOTE: launchctl settings do not survive a reboot. Re-run after each restart,"
echo "or create a LaunchAgent plist (run 'make server-launchagent' when available)."
echo ""
echo "--- Verify the hooks are in remote mode ---"
echo ""
echo "After restarting Claude Code, open a new session and look for:"
echo "  [context-manager] SessionStart hook invoked"
echo "  (no 'Error' lines — if you see CONTEXT_MANAGER_TOKEN error, the env var"
echo "   is not visible to the Claude Code process)"
echo ""
echo "Or check the server health directly:"
echo "  curl -s http://localhost:4000/health"
echo ""
echo "================================================================"
