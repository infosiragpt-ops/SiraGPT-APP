#!/usr/bin/env bash
#
# update-ui-lock.sh — re-baseline the UI lock to the CURRENT working tree.
#
# Run this AFTER an intentional, reviewed frontend change, then commit the
# updated docs/UI_LOCK_HASHES.txt alongside that change. The diff is part of
# code review, so the lock keeps its purpose (catch UNINTENDED visual-surface
# drift) while being a one-command, no-friction update — no hand-rolled
# `find … | shasum` and no detached-worktree gymnastics.
#
#   npm run ui-lock:update      # re-baseline
#   npm run ui-lock:verify      # confirm (same check CI runs)
#
# The tracked file set is defined once in scripts/ui-lock-files.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$PROJECT_ROOT/docs/UI_LOCK_HASHES.txt"

bash "$SCRIPT_DIR/ui-lock-files.sh" | xargs shasum -a 256 2>/dev/null | sort > "$LOCK_FILE"

COUNT="$(wc -l < "$LOCK_FILE" | tr -d ' ')"
echo "✅ UI lock re-baselined → docs/UI_LOCK_HASHES.txt (${COUNT} files)."
echo "   Review the diff and commit it together with your frontend change."
