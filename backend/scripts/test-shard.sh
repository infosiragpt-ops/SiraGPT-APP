#!/usr/bin/env bash
# test-shard.sh — run a deterministic 1-of-N slice of the backend test suite.
#
# The backend has ~1750 test files. Sharding lets CI run multiple GitHub
# Actions runners in parallel, each owning a round-robin slice of the list.
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
# The file list is DISCOVERED FROM DISK: every tests/**/*.test.js, minus the
# paths named in tests/.ci-quarantine.txt.
#
# It used to be derived by regex from the `npm test` script in package.json —
# an explicit, hand-maintained file list. That made inclusion opt-in, and
# opt-in silently loses tests: a file added to tests/ but not to package.json
# never ran, with no error and no warning anywhere. Measured on 2026-07-24 that
# had accumulated to 1133 of 1789 backend test files (63% of the suite) sitting
# on disk, fully written, never executed. Discovery-by-default makes the
# failure mode impossible: a new test file runs unless someone explicitly
# quarantines it in a reviewed diff.

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

QUARANTINE_FILE="tests/.ci-quarantine.txt"

# `mapfile` isn't on macOS' bash 3.2, so we use portable read loops throughout.
QUARANTINED=()
if [ -f "$QUARANTINE_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"                       # strip trailing comments
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && QUARANTINED+=("$line")
  done < "$QUARANTINE_FILE"
fi

# A quarantine entry pointing at a file that no longer exists is not harmless:
# it is a claim about coverage that has quietly stopped being true, and it hides
# typos that would otherwise silently exclude nothing (or, worse, the wrong
# file). Fail loudly so the list can never rot into over-exclusion.
STALE=()
for q in "${QUARANTINED[@]:-}"; do
  [ -n "$q" ] || continue
  [ -f "$q" ] || STALE+=("$q")
done
if (( ${#STALE[@]} > 0 )); then
  echo "ERROR: ${#STALE[@]} quarantined path(s) do not exist on disk:" >&2
  printf '  %s\n' "${STALE[@]}" >&2
  echo "Remove them from $QUARANTINE_FILE (the test is gone, so the exclusion is dead)." >&2
  exit 1
fi

ALL_FILES=()
while IFS= read -r f; do ALL_FILES+=("$f"); done < <(find tests -name '*.test.js' -type f | sort)

if (( ${#ALL_FILES[@]} == 0 )); then
  echo "ERROR: no test files found under tests/ — refusing to report success." >&2
  exit 1
fi

FILES=()
SKIPPED=0
for f in "${ALL_FILES[@]}"; do
  excluded=0
  for q in "${QUARANTINED[@]:-}"; do
    if [ "$f" = "$q" ]; then excluded=1; break; fi
  done
  if (( excluded )); then
    SKIPPED=$(( SKIPPED + 1 ))
  else
    FILES+=("$f")
  fi
done

# `[ -f "$q" ]` passing does not prove `$q` matches a discovered path: `./tests/x`
# and `tests/x` are the same file but different strings, so an entry written in
# the wrong form would pass the stale check and then quietly exclude nothing.
# Requiring the counts to agree pins the entries to the exact form `find` emits.
if (( SKIPPED != ${#QUARANTINED[@]} )); then
  echo "ERROR: ${#QUARANTINED[@]} quarantine entries but only ${SKIPPED} matched a discovered file." >&2
  echo "Entries must be written exactly as 'tests/<path>.test.js' with no duplicates." >&2
  exit 1
fi

echo "Discovered ${#ALL_FILES[@]} test files, ${SKIPPED} quarantined, ${#FILES[@]} eligible"

# Round-robin assignment: file index i goes to shard (i % TOTAL) + 1.
SHARD_FILES=()
for i in "${!FILES[@]}"; do
  if (( (i % TOTAL) + 1 == SHARD )); then
    SHARD_FILES+=("${FILES[$i]}")
  fi
done

echo "Running shard ${SHARD}/${TOTAL}: ${#SHARD_FILES[@]} of ${#FILES[@]} test files"

if (( ${#SHARD_FILES[@]} == 0 )); then
  # An empty shard is a green job that verified nothing. With N files and T
  # shards it only happens when N < T, i.e. discovery broke or the suite was
  # gutted — exactly the cases where a silent pass is most dangerous.
  echo "ERROR: shard ${SHARD}/${TOTAL} matched 0 of ${#FILES[@]} eligible files." >&2
  echo "A shard that runs no tests must not report success." >&2
  exit 1
fi

NODE_TEST_ARGS=(--test)
if [ "${CI:-}" = "true" ]; then
  # Some legacy suites leave background timers/sockets open after all tests
  # have reported. In CI that burns the whole shard timeout and cancels an
  # otherwise green run, so force Node to exit once the test runner is done.
  NODE_TEST_ARGS+=(--test-force-exit)
fi

exec node "${NODE_TEST_ARGS[@]}" "${SHARD_FILES[@]}"
