#!/usr/bin/env bash
# Pre-push hook: block direct pushes to main.
# All changes to main must go through a PR on GitHub.
#
# Installed automatically by: npm run prepare (via package.json)
# Manual install: bash scripts/install-hooks.sh

while read local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == "refs/heads/main" ]]; then
    echo ""
    echo "ERROR: Direct push to main is not allowed."
    echo ""
    echo "  All changes to main must go through a pull request."
    echo "  Push your branch to develop (or a feature branch) and open a PR."
    echo ""
    echo "  To open a PR:"
    echo "    gh pr create --base main --head develop --title \"Release: <version>\""
    echo ""
    exit 1
  fi
done

exit 0
