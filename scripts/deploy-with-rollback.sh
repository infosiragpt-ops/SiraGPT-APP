#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Production Deploy with Auto-Rollback
# ──────────────────────────────────────────────────────────────
# Wraps scripts/deploy-production.sh. Captures the current HEAD
# before deploying so that if the deploy fails (build error,
# /health timeout, OAuth redirect mismatch, etc.) we revert the
# working tree, rebuild the frontend, and restart PM2 to the
# previous known-good commit BEFORE returning a non-zero exit.
#
# The DB is dumped first via backup-db.sh — non-destructive
# (pg_dump + gzip), gives us a restore point if a future
# migration corrupts data. Failure to back up does NOT block
# the deploy (logged but tolerated) because requiring it would
# turn a transient pg_dump glitch into an outage trigger.
#
# Exit codes:
#   0 — deploy succeeded and is live
#   1 — deploy failed, rollback succeeded, prod restored
#   2 — deploy failed AND rollback failed (manual intervention)
# ──────────────────────────────────────────────────────────────

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/siraNew/siraGPT}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"
PM2_APP="${PM2_APP:-siraGPT-api}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.siragpt.com/health}"
API_LOCAL_HEALTH_URL="${API_LOCAL_HEALTH_URL:-http://127.0.0.1:${PORT:-5000}/health}"
BACKUP_DIR="${BACKUP_DIR:-/root/siragpt-backups/postgres}"

log() { printf '[deploy-with-rollback] %s\n' "$*"; }
err() { printf '[deploy-with-rollback] ERROR: %s\n' "$*" >&2; }

cleanup_docker_space() {
  if [[ "${DEPLOY_PRUNE_DOCKER:-1}" != "1" ]]; then
    log "Skipping Docker prune because DEPLOY_PRUNE_DOCKER is disabled"
    return 0
  fi

  log "Docker disk usage before cleanup"
  df -h / /var/lib/docker 2>/dev/null || df -h / || true
  docker system df || true

  log "Pruning Docker build cache, unused images, and stopped containers"
  docker builder prune -af || true
  docker image prune -af || true
  docker container prune -f || true

  log "Docker disk usage after cleanup"
  docker system df || true
  df -h / /var/lib/docker 2>/dev/null || df -h / || true
}

pm2_app_exists() {
  pm2 describe "$1" >/dev/null 2>&1
}

resolve_pm2_app() {
  local candidate detected
  local candidates="${PM2_APP_CANDIDATES:-${PM2_APP},siraGPT-api,sira-api,sira-api-backend,siragpt-api,siragpt-backend,backend}"

  IFS=',' read -r -a candidate_list <<< "$candidates"
  for candidate in "${candidate_list[@]}"; do
    candidate="$(printf '%s' "$candidate" | xargs)"
    [[ -n "$candidate" ]] || continue
    if pm2_app_exists "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  detected="$(
    pm2 jlist 2>/dev/null | node -e '
      const fs = require("fs");
      let list = [];
      try {
        const input = fs.readFileSync(0, "utf8").trim();
        list = input ? JSON.parse(input) : [];
      } catch {
        list = [];
      }
      const text = (p) => [
        p && p.name,
        p && p.pm2_env && p.pm2_env.pm_cwd,
        p && p.pm2_env && p.pm2_env.cwd,
        p && p.pm2_env && p.pm2_env.pm_exec_path,
        p && p.pm2_env && p.pm2_env.script
      ].filter(Boolean).join(" ");
      const preferred = list.find((p) => /siragpt|sira|backend|api/i.test(text(p)) && /siraGPT|siraNew|backend/i.test(text(p)));
      const fallback = list.find((p) => /siragpt|sira|backend|api/i.test(text(p)));
      const found = preferred || fallback;
      if (found && found.name) process.stdout.write(found.name);
    '
  )"

  if [[ -n "$detected" ]] && pm2_app_exists "$detected"; then
    printf '%s\n' "$detected"
    return 0
  fi

  return 1
}

restart_pm2_backend() {
  local resolved_pm2_app
  if ! resolved_pm2_app="$(resolve_pm2_app)"; then
    err "PM2 backend process not found. Set PM2_APP to the active backend process name."
    return 1
  fi

  if [[ "$resolved_pm2_app" != "$PM2_APP" ]]; then
    log "PM2 backend default '$PM2_APP' not found; using detected process: $resolved_pm2_app"
  fi

  log "Restarting PM2 backend: $resolved_pm2_app"
  pm2 restart "$resolved_pm2_app" --update-env
}

print_failure_diagnostics() {
  local resolved_pm2_app=""

  resolved_pm2_app="$(resolve_pm2_app 2>/dev/null || true)"

  err "Collecting deploy diagnostics"
  echo "=== git state ==="
  git --no-pager log -1 --oneline || true
  git status --short || true

  echo ""
  echo "=== public health (${API_HEALTH_URL}) ==="
  curl -k -i --max-time 10 "${API_HEALTH_URL}" || true

  echo ""
  echo "=== local backend health (${API_LOCAL_HEALTH_URL}) ==="
  curl -i --max-time 10 "${API_LOCAL_HEALTH_URL}" || true

  echo ""
  echo "=== PM2 list ==="
  pm2 list || true

  if [[ -n "$resolved_pm2_app" ]]; then
    echo ""
    echo "=== PM2 describe: ${resolved_pm2_app} ==="
    pm2 describe "$resolved_pm2_app" || true

    echo ""
    echo "=== PM2 logs: ${resolved_pm2_app} ==="
    pm2 logs "$resolved_pm2_app" --nostream --lines 120 || true
  fi

  echo ""
  echo "=== nginx recent errors ==="
  journalctl -u nginx --since "10 minutes ago" --no-pager -n 120 2>/dev/null || true
}

cd "$APP_DIR"

PREV_SHA="$(git rev-parse HEAD)"
log "Pre-deploy SHA: ${PREV_SHA}"
cleanup_docker_space

# Pre-deploy DB backup. Non-fatal — we want a snapshot in case
# the new code introduces a destructive migration, but a flaky
# pg_dump shouldn't take down the deploy itself.
if [[ -x scripts/backup-db.sh ]]; then
  log "Running pre-deploy DB backup to ${BACKUP_DIR}"
  if ! scripts/backup-db.sh "${BACKUP_DIR}"; then
    err "Backup failed but continuing (backup is non-fatal). Investigate post-deploy."
  fi
else
  err "scripts/backup-db.sh not found or not executable — skipping pre-deploy backup"
fi

# Run the deploy. If it succeeds, we're done.
set +e
scripts/deploy-production.sh
DEPLOY_EXIT=$?
set -e
if [[ "$DEPLOY_EXIT" -eq 0 ]]; then
  log "✅ Deploy successful at $(git rev-parse --short HEAD)"
  exit 0
fi

# ─── Rollback path ────────────────────────────────────────────
err "Deploy failed (exit ${DEPLOY_EXIT}). Rolling back to ${PREV_SHA}"
cleanup_docker_space

# 1. Reset working tree to the pre-deploy commit.
if ! git reset --hard "${PREV_SHA}"; then
  err "git reset --hard ${PREV_SHA} FAILED — manual intervention required"
  exit 2
fi

# 2. Rebuild + restart frontend from the rolled-back code.
if ! docker compose -f "${COMPOSE_FILE}" build "${FRONTEND_SERVICE}"; then
  err "Frontend rebuild during rollback FAILED — manual intervention required"
  exit 2
fi
if ! docker compose -f "${COMPOSE_FILE}" up -d --no-deps "${FRONTEND_SERVICE}"; then
  err "Frontend restart during rollback FAILED — manual intervention required"
  exit 2
fi

# 3. Restart backend PM2 process so it re-reads any env changes.
if ! restart_pm2_backend; then
  err "PM2 restart during rollback FAILED — manual intervention required"
  exit 2
fi

# 4. Verify the rolled-back stack is healthy.
sleep 5
for i in $(seq 1 20); do
  if curl -sSf -o /dev/null "${API_HEALTH_URL}"; then
    log "✅ Rollback successful — production restored to ${PREV_SHA:0:7}"
    exit 1   # deploy itself failed, signal that to the caller
  fi
  sleep 2
done

err "🔥 ROLLBACK HEALTH CHECK FAILED — manual intervention required"
err "Working tree is at ${PREV_SHA} but ${API_HEALTH_URL} is not responding"
print_failure_diagnostics
exit 2
