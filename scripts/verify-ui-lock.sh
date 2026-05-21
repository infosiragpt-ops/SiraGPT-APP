#!/usr/bin/env bash
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "==> Verifying UI lock..."
echo "     Check: git diff HEAD -- app/ components/ styles/ tailwind.config.js postcss.config.js"

# The canonical check: zero changes to any visual-surface file
CHANGES=$(git diff --name-only HEAD -- app/ components/ styles/ tailwind.config.js postcss.config.js 2>&1 || true)

if [[ -z "$CHANGES" ]]; then
  echo "✅ UI lock verified — zero changes to frontend files."
  exit 0
fi

echo "❌ UI LOCK VIOLATION DETECTED!"
echo "The following UI files have been modified:"
echo "$CHANGES"
echo ""
echo "This build cannot proceed. Revert UI changes before committing."
exit 1
