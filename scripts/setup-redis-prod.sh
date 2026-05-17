#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — One-shot Redis Prod Setup
# ──────────────────────────────────────────────────────────────
# Run this on the VPS ONCE after the docker-compose change that
# binds Redis to 127.0.0.1:6379 lands. It:
#
#   1. Re-creates the Redis container so the new port mapping
#      takes effect (data is preserved — volume isn't touched).
#   2. Adds REDIS_URL=redis://localhost:6379 to .env if absent.
#   3. Restarts PM2 backend so connect-redis picks up the env.
#   4. Sanity-checks: Redis pingable from host + backend healthy.
#
# Safe to re-run: each step is idempotent.
#
# Usage on VPS:
#   cd /root/siraNew/siraGPT && git pull && ./scripts/setup-redis-prod.sh
# ──────────────────────────────────────────────────────────────

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/siraNew/siraGPT}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
PM2_APP="${PM2_APP:-sira-api-backend}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.siragpt.com/health}"

log() { printf '[setup-redis-prod] %s\n' "$*"; }
err() { printf '[setup-redis-prod] ERROR: %s\n' "$*" >&2; }

cd "${APP_DIR}"

# 0. Install backend deps. connect-redis lives in backend/package.json but
# deploy-production.sh historically skipped `npm install`, so the dep is
# not on disk yet. Adding it here guards the script against a stale
# node_modules tree.
log "Installing backend production deps (idempotent)…"
(cd backend && npm install --omit=dev --no-audit --no-fund)

# 1. Recreate Redis container with new port mapping. Volume is preserved.
log "Recreating redis container (volume preserved)…"
docker compose -f "${COMPOSE_FILE}" up -d --no-deps --force-recreate redis

# Wait for redis healthcheck
for i in $(seq 1 20); do
  if docker compose -f "${COMPOSE_FILE}" exec -T redis redis-cli ping >/dev/null 2>&1; then
    log "✓ redis healthy"
    break
  fi
  [[ ${i} -eq 20 ]] && { err "redis didn't become healthy"; exit 1; }
  sleep 1
done

# 2. Verify Redis is reachable from the HOST (the backend's perspective).
if ! command -v nc >/dev/null 2>&1; then
  log "nc not installed — skipping host-side reachability probe"
else
  if nc -z 127.0.0.1 6379 2>/dev/null; then
    log "✓ Redis reachable from host on 127.0.0.1:6379"
  else
    err "Redis NOT reachable from host on 127.0.0.1:6379 — check docker-compose ports stanza"
    exit 1
  fi
fi

# 3. Ensure REDIS_URL is in .env (append only if missing — idempotent).
if [[ ! -f "${ENV_FILE}" ]]; then
  err "${ENV_FILE} not found"
  exit 1
fi
if grep -qE '^REDIS_URL=' "${ENV_FILE}"; then
  log "REDIS_URL already set in ${ENV_FILE} — leaving as-is"
else
  log "Adding REDIS_URL to ${ENV_FILE}"
  printf '\n# Added by setup-redis-prod.sh on %s\nREDIS_URL=redis://localhost:6379\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${ENV_FILE}"
fi

# 4. Restart PM2 backend so connect-redis activates.
log "Restarting ${PM2_APP} with updated env…"
pm2 restart "${PM2_APP}" --update-env

# 5. Wait for /health to come back. The backend takes a few seconds to
#    initialise the Redis session store before serving requests.
log "Polling ${API_HEALTH_URL}…"
for i in $(seq 1 30); do
  if curl -sSf -o /dev/null "${API_HEALTH_URL}"; then
    log "✓ Backend healthy after ${i}s"
    exit 0
  fi
  sleep 1
done
err "Backend did not become healthy after 30s. Check 'pm2 logs ${PM2_APP}'"
exit 1
