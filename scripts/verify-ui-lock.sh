#!/usr/bin/env bash
set -euo pipefail

# verify-ui-lock.sh — Verify zero changes to UI files
# Compares current SHA-256 hashes against the locked baseline.
# Exit 0 = clean (no UI changes). Exit 1 = violation detected.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$PROJECT_ROOT/docs/UI_LOCK_HASHES.txt"
TEMP_CURRENT="/tmp/ui_lock_current_$$.txt"

cd "$PROJECT_ROOT"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "ERROR: Lock file not found at $LOCK_FILE"
  echo "Generate it first with: find app components styles tailwind.config.js -type f ... | xargs shasum -a 256 > docs/UI_LOCK_HASHES.txt"
  exit 2
fi

echo "==> Verifying UI lock..."
echo "     Baseline: $LOCK_FILE"

# Generate current hashes for the same set of files
find app components styles tailwind.config.js postcss.config.js \
  -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.turbo/*" ! -path "*/dist/*" \
  | sort | xargs shasum -a 256 2>/dev/null | sort -k2 > "$TEMP_CURRENT"

# Compare
DIFF_OUTPUT=$(diff "$LOCK_FILE" "$TEMP_CURRENT" 2>&1) || true

if [[ -z "$DIFF_OUTPUT" ]]; then
  echo "✅ UI lock verified — zero changes to frontend files."
  rm -f "$TEMP_CURRENT"
  exit 0
else
  echo "❌ UI LOCK VIOLATION DETECTED!"
  echo "---"
  echo "$DIFF_OUTPUT"
  echo "---"
  echo "The following files have changed:"
  echo "$DIFF_OUTPUT" | grep '^[<>]' | awk '{print $3}' | sort -u
  echo ""
  echo "This build cannot proceed. Revert UI changes before committing."
  rm -f "$TEMP_CURRENT"
  exit 1
fi
