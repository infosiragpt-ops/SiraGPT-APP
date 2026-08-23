#!/usr/bin/env bash
#
# Git-anchored replacement for the historical VPS-only reapply script.
# The old host copy sed-patched built frontend files after every recreate.
# That never survived the next FE image. This script only VERIFIES the lock
# is present in source — it does not rewrite production files.
#
#   bash scripts/reapply-code-ui-lock.sh --check   # CI / local gate
#   bash scripts/reapply-code-ui-lock.sh           # print contract + check

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOCK="$ROOT/lib/code-chrome-lock.ts"
TOPBAR="$ROOT/components/code/workspace-top-bar.tsx"
COMPANY="$ROOT/components/code/agent-company-panel.tsx"
WORKSPACE="$ROOT/components/code/code-workspace.tsx"
DOC="$ROOT/docs/code-ui-lock.md"

fail() { echo "code-ui-lock: $*" >&2; exit 1; }

[[ -f "$LOCK" ]] || fail "missing $LOCK"
[[ -f "$DOC" ]] || fail "missing $DOC"

for label in Panel Controlar Archivos Recursos; do
  grep -q "\"$label\"" "$LOCK" || fail "lock SSOT missing forbidden nav label $label"
done
grep -q '"Ejecutar"' "$LOCK" || fail "lock SSOT missing Ejecutar"
grep -q '"Publicar"' "$LOCK" || fail "lock SSOT missing Publicar"
grep -q '"Computadora"' "$LOCK" || fail "lock SSOT missing kept Computadora"
grep -q '"Routines"' "$LOCK" || fail "lock SSOT missing kept Routines"
grep -q "showForbiddenCompanyNav: false" "$LOCK" || fail "showForbiddenCompanyNav must be false"
grep -q "showRunPublishButtons: false" "$LOCK" || fail "showRunPublishButtons must be false"

grep -q "CODE_CHROME_LOCK" "$TOPBAR" || fail "workspace-top-bar must import CODE_CHROME_LOCK"
grep -q "CODE_CHROME_LOCK.showRunPublishButtons" "$TOPBAR" || fail "Ejecutar/Publicar must be gated by CODE_CHROME_LOCK"
grep -q "workspace-header-department-computer" "$TOPBAR" || fail "Computadora button missing from top bar"

grep -q "CODE_CHROME_LOCK" "$COMPANY" || fail "agent-company-panel must import CODE_CHROME_LOCK"
grep -q "CODE_CHROME_LOCK.showForbiddenCompanyNav" "$COMPANY" || fail "company nav must be gated by CODE_CHROME_LOCK"

grep -q "hideDesktopTopBarOnPhone" "$WORKSPACE" || fail "code-workspace must honor hideDesktopTopBarOnPhone"
grep -q "DepartmentComputerPane\\|CodeMobileComputerOverlay\\|onOpenDepartmentComputer" "$WORKSPACE" \
  || fail "code-workspace must wire Computadora"

echo "code-ui-lock: OK (git-anchored, no VPS sed)"
if [[ "${1:-}" != "--check" ]]; then
  echo "Contract: hide Panel/Controlar/Archivos/Recursos + Ejecutar/Publicar; keep Routines + Computadora."
  echo "See docs/code-ui-lock.md and lib/code-chrome-lock.ts"
fi
