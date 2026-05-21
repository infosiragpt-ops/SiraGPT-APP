#!/usr/bin/env bash
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"
LOCK_FILE="$PROJECT_ROOT/docs/UI_LOCK_HASHES.txt"

cd "$PROJECT_ROOT"

echo "==> Verifying UI lock..."

# Check 1: Git diff — no changes to any visual-surface files
CHANGES=$(git diff --name-only HEAD -- \
  app/ components/ styles/ hooks/ lib/ \
  tailwind.config.js tailwind.config.ts tailwind.config.mjs tailwind.config.cjs \
  postcss.config.js postcss.config.mjs next.config.mjs next.config.js \
  2>&1 || true)

if [[ -n "$CHANGES" ]]; then
  echo "❌ UI LOCK VIOLATION DETECTED!"
  echo "The following UI files have been modified:"
  echo "$CHANGES"
  echo ""
  echo "This build cannot proceed. Revert UI changes before committing."
  exit 1
fi

echo "✅ UI lock verified — zero changes to frontend files."
exit 0
