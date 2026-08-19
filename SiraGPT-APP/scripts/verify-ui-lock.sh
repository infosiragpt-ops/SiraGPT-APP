#!/usr/bin/env bash
#
# verify-ui-lock.sh — CI gate: fail if any tracked frontend file differs from
# the committed baseline docs/UI_LOCK_HASHES.txt. The tracked file set lives in
# scripts/ui-lock-files.sh (shared with update-ui-lock.sh so they never drift).
# To accept an intentional change, run `npm run ui-lock:update`.

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

bash "$SCRIPT_DIR/ui-lock-files.sh" | xargs shasum -a 256 2>/dev/null | sort > "$TEMP_CURRENT"

DIFF_OUTPUT=$(diff "$LOCK_FILE" "$TEMP_CURRENT" 2>&1) || true

if [[ -z "$DIFF_OUTPUT" ]]; then
  echo "✅ UI lock verified — zero changes to frontend files."
  rm -f "$TEMP_CURRENT"
  exit 0
else
  echo "❌ UI LOCK VIOLATION DETECTED — these frontend files differ from the baseline:"
  DIFF_FILES=$(echo "$DIFF_OUTPUT" | grep '^[<>]' | awk '{print $NF}' | sed 's/^\.\///' | sort -u)
  if [[ -n "$DIFF_FILES" ]]; then
    echo "$DIFF_FILES" | head -20
  fi
  echo ""
  echo "If the change is INTENTIONAL, re-baseline with:"
  echo "    npm run ui-lock:update"
  echo "then commit the updated docs/UI_LOCK_HASHES.txt alongside your change."
  rm -f "$TEMP_CURRENT"
  exit 1
fi
