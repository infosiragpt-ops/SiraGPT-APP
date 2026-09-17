#!/usr/bin/env bash
# Entrypoint of the siragpt-github-runner container.
#
#   register  — one-off: configure the runner against the repository using a
#               short-lived registration token (RUNNER_TOKEN) and exit. The
#               resulting identity (.runner/.credentials) lives on the
#               persistent /home/runner volume; the token is never stored.
#   run       — default: start the runner listener (auto-updates itself).
set -Eeuo pipefail
cd /home/runner

mode=${1:-run}

case "$mode" in
  register)
    : "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"
    : "${RUNNER_TOKEN:?RUNNER_TOKEN (GitHub registration token) is required}"
    if [[ -f .runner ]]; then
      echo "[runner] already registered as $(jq -r .agentName .runner 2>/dev/null || echo '?'); skipping" >&2
      exit 0
    fi
    ./config.sh --unattended --replace \
      --url "$RUNNER_REPO_URL" \
      --token "$RUNNER_TOKEN" \
      --name "${RUNNER_NAME:-siragpt-lenovo}" \
      --labels "${RUNNER_LABELS:-siragpt-lenovo}" \
      --work _work
    ;;
  run)
    [[ -f .runner ]] || { echo "[runner] not registered yet; run the 'register' mode first" >&2; exit 1; }
    exec ./run.sh
    ;;
  *)
    exec "$@"
    ;;
esac
