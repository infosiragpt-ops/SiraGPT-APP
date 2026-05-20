#!/usr/bin/env bash
# Verifies the frozen UI contract captured in docs/UI_LOCK_HASHES.txt.
# Any changed, missing, or newly added TSX/CSS/tailwind config file under the
# locked UI paths fails the check.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HASH_FILE="$ROOT/docs/UI_LOCK_HASHES.txt"

if [[ ! -f "$HASH_FILE" ]]; then
  echo "UI lock hash file missing: docs/UI_LOCK_HASHES.txt" >&2
  exit 1
fi

cd "$ROOT"

TMP_CURRENT="$(mktemp)"
TMP_EXPECTED="$(mktemp)"
trap 'rm -f "$TMP_CURRENT" "$TMP_EXPECTED"' EXIT

LOCK_PATHS=(
  "client/src/components"
  "client/src/pages"
  "client/src/app"
  "app"
  "components"
  "styles"
)

{
  for path in "${LOCK_PATHS[@]}"; do
    [[ -e "$path" ]] || continue
    find "$path" -type f \( -name '*.tsx' -o -name '*.css' \) -print
  done
  find . -maxdepth 1 -type f \( -name 'tailwind.config.js' -o -name 'tailwind.config.ts' -o -name 'tailwind.config.mjs' -o -name 'tailwind.config.cjs' \) -print | sed 's#^\./##'
} | sort -u | while IFS= read -r file; do
  shasum -a 256 "$file" | awk -v f="$file" '{print $1 "  " f}'
done | sort -k2,2 > "$TMP_CURRENT"

grep -Ev '^(#|$)' "$HASH_FILE" | sort -k2,2 -u > "$TMP_EXPECTED"

if ! diff -u "$TMP_EXPECTED" "$TMP_CURRENT"; then
  echo "UI lock verification failed: visual-surface file hashes changed." >&2
  exit 1
fi

echo "UI lock verification passed: no locked TSX/CSS/tailwind files changed."
