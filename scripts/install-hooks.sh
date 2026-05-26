#!/usr/bin/env bash
# Install git hooks from scripts/ into .git/hooks/.
# Called automatically by npm run prepare.

set -e

HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

install_hook() {
  local name="$1"
  local src="$SCRIPTS_DIR/${name}-hook.sh"
  local dst="$HOOKS_DIR/$name"

  if [ ! -f "$src" ]; then
    echo "[hooks] No source for $name, skipping."
    return
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "[hooks] Installed $name hook."
}

install_hook "pre-push"

echo "[hooks] Git hooks installed."
