#!/usr/bin/env bash
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "==> Verifying UI lock..."
echo "     Baseline: docs/UI_LOCK_HASHES.txt"
echo "     Strategy: file-hash diff + git diff fallback"

# Strategy 1: Compare SHA-256 hashes against locked baseline
LOCK_FILE="$PROJECT_ROOT/docs/UI_LOCK_HASHES.txt"
TEMP_CURRENT="/tmp/ui_lock_current_$$.txt"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "ERROR: Lock file not found at $LOCK_FILE"
  exit 2
fi

# Generate current hashes for locked UI surface
find app components styles tailwind.config.js postcss.config.js \
  -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.ts" -o -name "*.js" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.turbo/*" ! -path "*/dist/*" \
  ! -path "app/api/*" 2>/dev/null \
  | sort | xargs shasum -a 256 2>/dev/null | sort -k2 > "$TEMP_CURRENT"

# Extract just the set of files from both for comparison
cut -d' ' -f3- "$LOCK_FILE" | sort > "/tmp/ui_lock_baseline_files_$$.txt"
cut -d' ' -f3- "$TEMP_CURRENT" | sort > "/tmp/ui_lock_current_files_$$.txt"

MISSING=$(comm -23 "/tmp/ui_lock_baseline_files_$$.txt" "/tmp/ui_lock_current_files_$$.txt")
EXTRA=$(comm -13 "/tmp/ui_lock_baseline_files_$$.txt" "/tmp/ui_lock_current_files_$$.txt")

if [[ -n "$MISSING" ]]; then
  echo "WARNING: Files in baseline but not found on disk:"
  echo "$MISSING"
fi

if [[ -n "$EXTRA" ]]; then
  echo "WARNING: New locked-surface files not in baseline (hash check may mismatch):"
  echo "$EXTRA"
fi

# Compare hashes
DIFF_OUTPUT=$(diff "$LOCK_FILE" "$TEMP_CURRENT" 2>&1) || true

if [[ -z "$DIFF_OUTPUT" ]]; then
  echo "✅ UI lock verified — zero changes to frontend files."
  rm -f "$TEMP_CURRENT" "/tmp/ui_lock_baseline_files_$$.txt" "/tmp/ui_lock_current_files_$$.txt"
  exit 0
fi

# Hash mismatch means files may have changed, but check if
# it's only new files that weren't in baseline
if [[ -n "$EXTRA" ]] && [[ -z "$MISSING" ]]; then
  # Only new files — filter them out of the diff to see if existing files match
  FILTERED_DIFF=$(diff "$LOCK_FILE" "$TEMP_CURRENT" 2>&1 | grep -v "^>.*$(echo "$EXTRA" | tr '\n' '|' | sed 's/|$//')" || true)
  if [[ -z "$FILTERED_DIFF" ]]; then
    echo "✅ UI lock verified — existing files unchanged (new files detected but not violations)."
    rm -f "$TEMP_CURRENT" "/tmp/ui_lock_baseline_files_$$.txt" "/tmp/ui_lock_current_files_$$.txt"
    exit 0
  fi
fi

echo "❌ UI LOCK VIOLATION DETECTED!"
echo "---"
echo "$DIFF_OUTPUT" | head -80
echo "---"
echo "The following files have changed:"
echo "$DIFF_OUTPUT" | grep '^[<>]' | awk '{print $3}' | sort -u
echo ""
echo "This build cannot proceed. Revert UI changes before committing."
rm -f "$TEMP_CURRENT" "/tmp/ui_lock_baseline_files_$$.txt" "/tmp/ui_lock_current_files_$$.txt"
exit 1
