#!/usr/bin/env bash
#
# Git-anchored /code chrome lock verifier.
# The old host copy sed-patched built frontend files after every recreate
# and treated leftover argv as a cd target, which breaks when the first
# argument is `--check` (a flag, not a directory). This script only
# VERIFIES the lock is present in source — it does not rewrite production
# files and never cds using argv.
#
#   bash scripts/reapply-code-ui-lock.sh --check   # CI / local gate
#   bash scripts/reapply-code-ui-lock.sh           # print contract + check

set -euo pipefail

SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT}"

CHECK=0
for arg in "$@"; do
  case "${arg}" in
    --check) CHECK=1 ;;
    -h|--help)
      echo "Usage: bash scripts/reapply-code-ui-lock.sh [--check]"
      exit 0
      ;;
    *)
      echo "code-ui-lock: unknown argument: ${arg}" >&2
      echo "Usage: bash scripts/reapply-code-ui-lock.sh [--check]" >&2
      exit 2
      ;;
  esac
done

LOCK="${ROOT}/lib/code-chrome-lock.ts"
TOPBAR="${ROOT}/components/code/workspace-top-bar.tsx"
COMPANY="${ROOT}/components/code/agent-company-panel.tsx"
CHAT="${ROOT}/components/code/ai-code-chat-panel.tsx"
WORKSPACE="${ROOT}/components/code/code-workspace.tsx"
DOC="${ROOT}/docs/code-ui-lock.md"

fail() { echo "code-ui-lock: $*" >&2; exit 1; }

[[ -f "${LOCK}" ]] || fail "missing ${LOCK}"
[[ -f "${DOC}" ]] || fail "missing ${DOC}"

for label in Panel Controlar Archivos Recursos; do
  grep -q "\"${label}\"" "${LOCK}" || fail "lock SSOT missing forbidden nav label ${label}"
done
grep -q '"Arrancando"' "${LOCK}" || fail "lock SSOT missing Arrancando"
grep -q '"Ejecutar"' "${LOCK}" || fail "lock SSOT missing Ejecutar"
grep -q '"Detener"' "${LOCK}" || fail "lock SSOT missing Detener"
grep -q '"Publicar"' "${LOCK}" || fail "lock SSOT missing kept Publicar"
grep -q '"Computadora"' "${LOCK}" || fail "lock SSOT missing kept Computadora"
grep -q '"Routines"' "${LOCK}" || fail "lock SSOT missing kept Routines"
grep -q "showForbiddenCompanyNav: false" "${LOCK}" || fail "showForbiddenCompanyNav must be false"
grep -q "showHeaderRunStopButton: false" "${LOCK}" || fail "showHeaderRunStopButton must be false"
grep -q "keepPublishButton: true" "${LOCK}" || fail "keepPublishButton must be true"

grep -q "CODE_CHROME_LOCK" "${TOPBAR}" || fail "workspace-top-bar must import CODE_CHROME_LOCK"
grep -q "CODE_CHROME_LOCK.keepPublishButton" "${TOPBAR}" || fail "Publicar must be gated by keepPublishButton"
grep -q "workspace-header-department-computer" "${TOPBAR}" || fail "Computadora button missing from top bar"
grep -q "bg-zinc-900" "${TOPBAR}" || fail "Publicar must keep zinc-900"
if grep -q "workspace-header-run-stop" "${TOPBAR}"; then
  fail "workspace-header-run-stop must not exist on the top bar"
fi
if grep -q "Arrancando" "${TOPBAR}"; then
  fail "Arrancando must not exist on the top bar"
fi
if grep -Eq '>(Ejecutar|Detener)<' "${TOPBAR}"; then
  fail "Ejecutar/Detener header labels must not exist on the top bar"
fi
if grep -q "bg-emerald-600" "${TOPBAR}"; then
  fail "emerald run/stop styling must not exist on the top bar"
fi

grep -q "CODE_CHROME_LOCK" "${COMPANY}" || fail "agent-company-panel must import CODE_CHROME_LOCK"
grep -q "CODE_CHROME_LOCK.showForbiddenCompanyNav" "${COMPANY}" || fail "company nav must be gated by CODE_CHROME_LOCK"
grep -q 'data-testid="code-routines-slot"' "${COMPANY}" || fail "Routines slot missing"
for label in Panel Controlar Archivos Recursos; do
  if grep -q "label=\"${label}\"" "${COMPANY}"; then
    fail "company home must not mount label=\"${label}\""
  fi
done

grep -q "function EmptyChat" "${CHAT}" || fail "EmptyChat helper missing"
if ! grep -q "return null" "${CHAT}"; then
  fail "EmptyChat must return null"
fi

grep -q "DepartmentComputerPane\\|CodeMobileComputerOverlay\\|onOpenDepartmentComputer" "${WORKSPACE}" \
  || fail "code-workspace must wire Computadora"

echo "code-ui-lock: OK (git-anchored, no VPS sed, argv is not a cd target)"
if [[ "${CHECK}" -eq 0 ]]; then
  echo "Contract: hide Panel/Controlar/Archivos/Recursos + Arrancando/Ejecutar/Detener; keep Publicar + Routines + Computadora; EmptyChat null."
  echo "See docs/code-ui-lock.md and lib/code-chrome-lock.ts"
fi
