#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$PROJECT_ROOT/docs/UI_LOCK_HASHES.txt"
TEMP_CURRENT="/tmp/ui_lock_current_$$.txt"

cd "$PROJECT_ROOT"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "ERROR: Lock file not found at $LOCK_FILE"
  exit 2
fi

echo "==> Verifying UI lock..."
echo "     Baseline: $LOCK_FILE"

find app components styles tailwind.config.js postcss.config.js \
  -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.turbo/*" ! -path "*/dist/*" \
  2>/dev/null \
  | sort | xargs shasum -a 256 2>/dev/null | sort -k2 > "$TEMP_CURRENT"

DIFF_OUTPUT=$(diff "$LOCK_FILE" "$TEMP_CURRENT" 2>&1) || true

if [[ -z "$DIFF_OUTPUT" ]]; then
  echo "✅ UI lock verified — zero changes to frontend files."
  rm -f "$TEMP_CURRENT"
  exit 0
else
  echo "❌ UI LOCK VIOLATION DETECTED!"
  DIFF_FILES=$(echo "$DIFF_OUTPUT" | grep '^[<>]' | awk '{print $NF}' | sed 's/^\.\///' | sort -u)
  if [[ -n "$DIFF_FILES" ]]; then
    echo "$DIFF_FILES" | head -20
  fi
  echo ""
  echo "This build cannot proceed. Revert UI changes before committing."
  rm -f "$TEMP_CURRENT"
  exit 1
fi
