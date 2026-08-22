#!/usr/bin/env bash
# preserve-code-patches.sh — ilación guard for VPS-only /code + ACS patches.
# Run BEFORE any frontend image rebuild / --force-recreate frontend.
# Verifies protected host files still contain required markers and that
# docker-compose.production.override.yml comments list them.
set -euo pipefail
ROOT="${1:-/opt/siragpt}"
cd "$ROOT"

fail=0
check() {
  local file="$1"; shift
  if [[ ! -f "$file" ]]; then
    echo "MISSING $file"; fail=1; return
  fi
  for needle in "$@"; do
    if ! grep -q -- "$needle" "$file"; then
      echo "FAIL $file missing marker: $needle"
      fail=1
    else
      echo "OK   $file :: $needle"
    fi
  done
}

echo "=== /code UI markers ==="
check components/code/activity-bar.tsx "ToolsRail" "export function ToolsRail"
check components/code/code-workspace.tsx "DepartmentComputerPane" "ToolsRail" "prewarmDepartmentDesktop" "CODE_OPEN_DEPARTMENT_COMPUTER_EVENT"
check components/code/department-computer-pane.tsx "autoconnect=1" "agent-computer" "prewarmDepartmentDesktop"
check lib/code-workspace-context.tsx "CODE_OPEN_DEPARTMENT_COMPUTER_EVENT"
check components/claude-thinking-timeline.tsx "ClaudeThinkingTimeline" "data-claude-thinking"
check components/thinking-placeholder.tsx "ClaudeThinkingTimeline"
check components/agent-trace.tsx "ClaudeThinkingTimeline"

echo "=== ACS / computer autonomy markers ==="
check backend/src/services/computer/orch-client.js "siragpt.com/agent-computer" "reconnect=1"
check backend/src/services/agent-runner/multimodal/computer.js "tryPersistentComputer" "computer_navigate"
check backend/src/services/agent-runner/multimodal/index.js "desktopCtx"
check backend/src/services/agent-runner/index.js "desktopCtx"
check deploy/Caddyfile "handle /agent-computer/*" "forward_auth"

echo "=== continuity note in override ==="
if grep -q "PROTECTED /code FILES" docker-compose.production.override.yml; then
  echo "OK   override lists protected files"
else
  echo "WARN override missing PROTECTED /code FILES comment block"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "PRESERVE_CHECK_FAILED — do NOT rebuild/recreate frontend until markers are restored."
  exit 1
fi
echo "PRESERVE_CHECK_OK"
