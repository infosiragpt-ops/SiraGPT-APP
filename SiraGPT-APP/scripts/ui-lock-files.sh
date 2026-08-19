#!/usr/bin/env bash
#
# ui-lock-files.sh — SINGLE SOURCE OF TRUTH for which frontend files the UI
# lock tracks. Prints the matching file paths (relative to the project root),
# one per line, sorted. Both scripts/verify-ui-lock.sh (the CI gate) and
# scripts/update-ui-lock.sh consume this, so the file set can never drift
# between "what we verify" and "what we re-baseline". Change the glob HERE and
# both stay in sync.
#
# Intentionally does NOT `set -e`: `find` can return non-zero when one of the
# explicitly-listed config files is absent in a given checkout, and that must
# not abort the listing (matches the historical tolerant behaviour). Always
# exits 0 so callers can pipe it safely under `set -o pipefail`.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

find app components hooks lib styles tailwind.config.js postcss.config.js postcss.config.mjs next.config.mjs \
  -type f \( -name "*.tsx" -o -name "*.css" -o -name "*.ts" -o -name "*.js" -o -name "*.mjs" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.turbo/*" ! -path "*/dist/*" \
  2>/dev/null \
  | sort

exit 0
