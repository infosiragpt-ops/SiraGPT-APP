#!/usr/bin/env bash
# scripts/profile-precommit.sh
# Profile the pre-commit pipeline by timing each step against the currently
# staged files. Prints a small report with per-step wall-clock seconds.
#
# Usage:
#   scripts/profile-precommit.sh           # profile staged files
#   FILES="a.ts b.ts" scripts/profile-precommit.sh   # profile explicit list
#
# Steps measured:
#   1. secret-check  — scripts/check-secrets.sh on changed files
#   2. eslint        — `next lint --file` on changed .ts/.tsx/.js/.jsx
#   3. tsc           — `tsc --noEmit` if any .ts/.tsx is staged (else skipped)

set -u

cd "$(dirname "$0")/.." || exit 1

# ---------------------------------------------------------------------------
# Collect file list
# ---------------------------------------------------------------------------
ALL_FILES=()
if [[ -n "${FILES:-}" ]]; then
  # shellcheck disable=SC2206
  ALL_FILES=( $FILES )
else
  while IFS= read -r line; do
    [[ -n "$line" ]] && ALL_FILES+=( "$line" )
  done < <(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)
fi

if [[ ${#ALL_FILES[@]} -eq 0 ]]; then
  echo "profile-precommit: no staged files (or FILES empty). Nothing to do."
  exit 0
fi

# Filter into buckets
LINT_FILES=()
TS_FILES=()
SECRET_FILES=()
for f in "${ALL_FILES[@]}"; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.ts|*.tsx)        LINT_FILES+=("$f"); TS_FILES+=("$f"); SECRET_FILES+=("$f");;
    *.js|*.jsx|*.cjs|*.mjs)
                        LINT_FILES+=("$f"); SECRET_FILES+=("$f");;
    *.json|*.md|*.yml|*.yaml|*.env|*.sh|*.toml)
                        SECRET_FILES+=("$f");;
  esac
done

now_ms() {
  # Portable millisecond timestamp (macOS lacks GNU date %N).
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
  else
    # Fall back to seconds resolution.
    echo $(( $(date +%s) * 1000 ))
  fi
}

run_step() {
  local label="$1"; shift
  local start end elapsed status
  start=$(now_ms)
  "$@" >/tmp/profile-precommit.out 2>&1
  status=$?
  end=$(now_ms)
  elapsed=$(( end - start ))
  printf '  %-14s %6d ms   (exit=%d)\n' "$label" "$elapsed" "$status"
  if [[ $status -ne 0 ]]; then
    echo "    --- output (first 10 lines) ---"
    head -n 10 /tmp/profile-precommit.out | sed 's/^/    /'
  fi
  return $status
}

echo "profile-precommit: staged file counts -> all=${#ALL_FILES[@]} lint=${#LINT_FILES[@]} ts=${#TS_FILES[@]} secret=${#SECRET_FILES[@]}"
echo

TOTAL_START=$(now_ms)

if [[ ${#SECRET_FILES[@]} -gt 0 ]]; then
  run_step "secret-check" bash scripts/check-secrets.sh "${SECRET_FILES[@]}"
else
  printf '  %-14s %s\n' "secret-check" "skipped (no eligible files)"
fi

if [[ ${#LINT_FILES[@]} -gt 0 ]]; then
  run_step "eslint" npx --no-install next lint --max-warnings 97 \
    $(printf -- '--file %q ' "${LINT_FILES[@]}")
else
  printf '  %-14s %s\n' "eslint" "skipped (no JS/TS files)"
fi

if [[ ${#TS_FILES[@]} -gt 0 ]]; then
  run_step "tsc" npx --no-install tsc --noEmit --skipLibCheck --ignoreDeprecations 5.0
else
  printf '  %-14s %s\n' "tsc" "skipped (no .ts/.tsx staged)"
fi

TOTAL_END=$(now_ms)
echo
printf 'profile-precommit: total wall-clock %d ms\n' $(( TOTAL_END - TOTAL_START ))
