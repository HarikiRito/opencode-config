#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$ROOT_DIR/plugins/opencode-claude"
REPO_URL="https://github.com/HarikiRito/opencode-claude.git"

if [ -d "$TARGET_DIR/.git" ]; then
  echo "updating opencode-claude plugin..."
  git -C "$TARGET_DIR" pull --ff-only || echo "warning: git pull failed, using existing checkout" >&2
else
  echo "cloning opencode-claude plugin..."
  git clone "$REPO_URL" "$TARGET_DIR"
fi

PNPM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v npx >/dev/null 2>&1; then
      PNPM="npx pnpm"
    else
      echo "error: pnpm not found (no pnpm, corepack, or npx on PATH)" >&2
      exit 1
    fi
  fi
fi

echo "installing dependencies..."
(cd "$TARGET_DIR" && $PNPM install --silent)

echo "building plugin..."
(cd "$TARGET_DIR" && $PNPM run build)

if [ -f "$TARGET_DIR/opencode-claude.js" ] && [ -f "$TARGET_DIR/dist/index.js" ]; then
  echo "success: opencode-claude plugin ready at $TARGET_DIR"
  echo "restart opencode to pick up the plugin"
else
  echo "error: expected build output missing (opencode-claude.js / dist/index.js)" >&2
  exit 1
fi
