#!/usr/bin/env bash
#
# reapply-code-ui-lock.sh — keep the Empresas /code polish lock honest.
# Fails if the green Ejecutar / Arrancando play button returns to the
# workspace top bar, then refreshes the global UI lock hashes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOP_BAR="$PROJECT_ROOT/components/code/workspace-top-bar.tsx"
ROUTINES="$PROJECT_ROOT/components/code/company-routines-panel.tsx"

fail() {
  echo "❌ code UI lock: $*" >&2
  exit 1
}

[[ -f "$TOP_BAR" ]] || fail "missing $TOP_BAR"

if grep -q 'data-testid="workspace-header-run-stop"' "$TOP_BAR"; then
  fail "green Ejecutar button returned (workspace-header-run-stop). Keep run in the ⋯ overflow only."
fi

if grep -q 'bg-emerald-600' "$TOP_BAR"; then
  fail "green Ejecutar play control returned to the top bar."
fi

if grep -q 'workspace-header-run-overflow' "$TOP_BAR" && ! grep -q 'workspace-header-overflow' "$TOP_BAR"; then
  fail "run action is not inside the overflow ⋯ menu."
fi

if [[ -f "$ROUTINES" ]] && grep -q '>Routines<' "$ROUTINES"; then
  fail "English 'Routines' heading found. Use 'Rutinas'."
fi

if ! grep -q 'data-empresas-no-run-button="1"' "$TOP_BAR"; then
  fail "top bar lost data-empresas-no-run-button lock marker."
fi

echo "✅ Empresas code UI lock: Ejecutar stays out of the top-bar DOM."
bash "$SCRIPT_DIR/update-ui-lock.sh"
echo "✅ Re-applied docs/UI_LOCK_HASHES.txt"
