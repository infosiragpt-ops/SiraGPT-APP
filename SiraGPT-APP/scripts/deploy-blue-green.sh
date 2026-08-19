#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Blue-Green Deploy Scaffold (cycle 34)
# ──────────────────────────────────────────────────────────────
# Brings up a NEW container next to the live one, probes its
# /health/ready endpoint, and only swaps nginx upstream when the
# new container is healthy. On failure the new container is
# stopped and the old one keeps serving — zero-downtime intent.
#
# A 30s drain period is applied before stopping the old container
# so in-flight requests have time to finish.
#
# This script is a SCAFFOLD: it assumes nginx upstreams are
# declared in /etc/nginx/conf.d/siragpt-upstream.conf with two
# named upstream blocks (siragpt_blue, siragpt_green) and a
# symlink /etc/nginx/conf.d/siragpt-active.conf → one of them.
# Adjust paths/names to your infra before relying on it in prod.
#
# Usage:
#   IMAGE=siragpt-frontend:abc123 ./scripts/deploy-blue-green.sh
#
# Env knobs:
#   IMAGE                        - docker image:tag to deploy (required)
#   ACTIVE_COLOR_FILE            - file storing currently active color
#                                  (default: /root/siragpt/.active-color)
#   HEALTH_URL_TEMPLATE          - e.g. http://localhost:%PORT%/health/ready
#   BLUE_PORT / GREEN_PORT       - host ports for each container
#   DRAIN_SECONDS                - default 30
#   HEALTH_TIMEOUT_SECONDS       - default 60
# ──────────────────────────────────────────────────────────────

set -Eeuo pipefail

IMAGE="${IMAGE:-}"
if [[ -z "${IMAGE}" ]]; then
  echo "[deploy-blue-green] ERROR: IMAGE env var is required (e.g. IMAGE=siragpt-frontend:sha-abc)" >&2
  exit 2
fi

ACTIVE_COLOR_FILE="${ACTIVE_COLOR_FILE:-/root/siragpt/.active-color}"
HEALTH_URL_TEMPLATE="${HEALTH_URL_TEMPLATE:-http://localhost:%PORT%/health/ready}"
BLUE_PORT="${BLUE_PORT:-3010}"
GREEN_PORT="${GREEN_PORT:-3011}"
DRAIN_SECONDS="${DRAIN_SECONDS:-30}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
NGINX_ACTIVE_LINK="${NGINX_ACTIVE_LINK:-/etc/nginx/conf.d/siragpt-active.conf}"
NGINX_BLUE_CONF="${NGINX_BLUE_CONF:-/etc/nginx/conf.d/siragpt-blue.conf}"
NGINX_GREEN_CONF="${NGINX_GREEN_CONF:-/etc/nginx/conf.d/siragpt-green.conf}"

log() { printf '[deploy-blue-green] %s\n' "$*"; }
err() { printf '[deploy-blue-green] ERROR: %s\n' "$*" >&2; }

current_color() {
  if [[ -f "${ACTIVE_COLOR_FILE}" ]]; then
    cat "${ACTIVE_COLOR_FILE}"
  else
    echo "blue" # first deploy assumption
  fi
}

other_color() {
  if [[ "$1" == "blue" ]]; then echo "green"; else echo "blue"; fi
}

port_for_color() {
  if [[ "$1" == "blue" ]]; then echo "${BLUE_PORT}"; else echo "${GREEN_PORT}"; fi
}

nginx_conf_for_color() {
  if [[ "$1" == "blue" ]]; then echo "${NGINX_BLUE_CONF}"; else echo "${NGINX_GREEN_CONF}"; fi
}

ACTIVE="$(current_color)"
TARGET="$(other_color "${ACTIVE}")"
TARGET_PORT="$(port_for_color "${TARGET}")"
ACTIVE_PORT="$(port_for_color "${ACTIVE}")"
CONTAINER_NAME="siragpt-frontend-${TARGET}"

log "Active color: ${ACTIVE} (port ${ACTIVE_PORT})"
log "Deploying to: ${TARGET} (port ${TARGET_PORT}) image=${IMAGE}"

# 1. Pull image
docker pull "${IMAGE}" || { err "docker pull failed"; exit 1; }

# 2. Remove any stale target container, start new one
docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${TARGET_PORT}:3000" \
  --env-file /root/siragpt/.env.production \
  "${IMAGE}"

# 3. Poll /health/ready on the new container
HEALTH_URL="${HEALTH_URL_TEMPLATE/\%PORT\%/${TARGET_PORT}}"
log "Polling ${HEALTH_URL} (timeout ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
healthy=0
while [[ $(date +%s) -lt ${deadline} ]]; do
  if curl -sSf -o /dev/null --max-time 5 "${HEALTH_URL}"; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ ${healthy} -ne 1 ]]; then
  err "Target ${TARGET} did not become healthy in ${HEALTH_TIMEOUT_SECONDS}s — aborting swap"
  docker logs --tail 100 "${CONTAINER_NAME}" >&2 || true
  docker stop "${CONTAINER_NAME}" || true
  docker rm "${CONTAINER_NAME}" || true
  exit 1
fi
log "Target ${TARGET} is healthy"

# 4. Swap nginx upstream symlink → reload
TARGET_CONF="$(nginx_conf_for_color "${TARGET}")"
if [[ ! -f "${TARGET_CONF}" ]]; then
  err "Missing nginx conf ${TARGET_CONF} for color ${TARGET} — cannot swap"
  err "Leaving new container running on port ${TARGET_PORT}; old container still serving"
  exit 1
fi

log "Swapping nginx active → ${TARGET_CONF}"
ln -sfn "${TARGET_CONF}" "${NGINX_ACTIVE_LINK}"
if ! nginx -t; then
  err "nginx -t failed AFTER swap — reverting symlink"
  ln -sfn "$(nginx_conf_for_color "${ACTIVE}")" "${NGINX_ACTIVE_LINK}"
  nginx -t || true
  docker stop "${CONTAINER_NAME}" || true
  docker rm "${CONTAINER_NAME}" || true
  exit 1
fi
nginx -s reload
log "nginx reloaded — traffic now hitting ${TARGET}"
echo "${TARGET}" > "${ACTIVE_COLOR_FILE}"

# 5. Drain old container
OLD_CONTAINER="siragpt-frontend-${ACTIVE}"
log "Draining ${OLD_CONTAINER} for ${DRAIN_SECONDS}s before stop"
sleep "${DRAIN_SECONDS}"
if docker ps -q -f "name=${OLD_CONTAINER}" | grep -q .; then
  docker stop "${OLD_CONTAINER}" || err "failed to stop ${OLD_CONTAINER} (continuing)"
  log "Stopped ${OLD_CONTAINER}"
else
  log "Old container ${OLD_CONTAINER} was not running (first deploy?)"
fi

log "✅ Blue-green deploy complete: ${ACTIVE} → ${TARGET}"
exit 0
