#!/usr/bin/env bash
# server-env.sh -- Explain remote mode env var loading.
#
# As of v0.8.32, hooks load ~/.claude-context/.env automatically at startup.
# No manual shell configuration is required.

set -euo pipefail

ENV_FILE="${HOME}/.claude-context/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Run 'make server-init' first." >&2
  exit 1
fi

echo ""
echo "================================================================"
echo " context-manager remote mode -- environment"
echo "================================================================"
echo ""
echo "Token and URL are stored in: ${ENV_FILE}"
echo ""
echo "Hooks read this file automatically at startup."
echo "No shell configuration (export, launchctl) is required."
echo ""
echo "To activate remote mode:"
echo "  1. Start the server: make server-quickstart  (macOS)"
echo "     or:               make server-start       (Linux)"
echo "  2. Restart Claude Code."
echo ""
echo "Verify: curl -s http://localhost:4000/health"
echo "================================================================"
