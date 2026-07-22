#!/usr/bin/env bash
# test-shard.sh — run a deterministic 1-of-N slice of the backend test suite.
#
# The backend has ~1342+ tests and the `npm test` script hard-codes the full
# file list. Sharding lets CI run multiple GitHub Actions runners in parallel,
# each owning a round-robin slice of the file list.
#
# Usage:
#   bash scripts/test-shard.sh <SHARD> <TOTAL>
#   bash scripts/test-shard.sh 1 4         # shard 1 of 4
#
# Selection rule: round-robin by index (file N goes to shard (N % TOTAL) + 1).
# Round-robin (vs contiguous slices) spreads slow/fast files more evenly, so
# wall-clock variance between shards stays low without needing per-file timing
# data.
#
# The full file list is derived from the existing `npm test` script (or, if
# absent, every *.test.js under tests/) so a single source of truth governs
# "what runs in CI".

set -euo pipefail

SHARD="${1:-1}"
TOTAL="${2:-1}"

if ! [[ "$SHARD" =~ ^[0-9]+$ ]] || ! [[ "$TOTAL" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <shard> <total>" >&2
  exit 2
fi
if (( SHARD < 1 || SHARD > TOTAL )); then
  echo "shard $SHARD out of range 1..$TOTAL" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# Extract the canonical file list from package.json `test` plus the focused
# project-database, logger-redaction, and deploy-contract suites (regex picks every
# tests/*.test.js token), falling back to a directory scan.
# `mapfile` isn't on macOS' bash 3.2, so we use a portable read loop.
FILES=()
while IFS= read -r line; do
  [ -n "$line" ] && FILES+=("$line")
done < <(
  node -e "
    const p = require('./package.json');
    const cmd = [
      p.scripts && p.scripts.test,
      p.scripts && p.scripts['test:codex-project-database'],
      p.scripts && p.scripts['test:logger-redaction'],
      p.scripts && p.scripts['test:deploy-contract'],
    ].filter(Boolean).join(' ');
    const m = cmd.match(/tests\\/[A-Za-z0-9._\\-\\/]+\\.test\\.js/g) || [];
    if (m.length) { console.log(m.join('\\n')); }
  "
)

if [ ${#FILES[@]} -eq 0 ]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(find tests -name '*.test.js' -type f | sort)
fi

# Round-robin assignment: file index i goes to shard (i % TOTAL) + 1.
SHARD_FILES=()
for i in "${!FILES[@]}"; do
  if (( (i % TOTAL) + 1 == SHARD )); then
    SHARD_FILES+=("${FILES[$i]}")
  fi
done

echo "Running shard ${SHARD}/${TOTAL}: ${#SHARD_FILES[@]} of ${#FILES[@]} test files"

if (( ${#SHARD_FILES[@]} == 0 )); then
  echo "No files in this shard — nothing to do."
  exit 0
fi

NODE_TEST_ARGS=(--test)
if [ "${CI:-}" = "true" ]; then
  # Some legacy suites leave background timers/sockets open after all tests
  # have reported. In CI that burns the whole shard timeout and cancels an
  # otherwise green run, so force Node to exit once the test runner is done.
  NODE_TEST_ARGS+=(--test-force-exit)
fi

exec node "${NODE_TEST_ARGS[@]}" "${SHARD_FILES[@]}"
