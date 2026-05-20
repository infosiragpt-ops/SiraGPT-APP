#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/siraNew/siraGPT}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
FRONTEND_SERVICE="${FRONTEND_SERVICE:-frontend}"
PM2_APP="${PM2_APP:-sira-api-backend}"
DEPLOY_AUTO_STASH_LOCAL_CHANGES="${DEPLOY_AUTO_STASH_LOCAL_CHANGES:-1}"

FRONTEND_URL="${FRONTEND_URL:-https://siragpt.com/auth/login}"
API_HEALTH_URL="${API_HEALTH_URL:-https://api.siragpt.com/health}"
GOOGLE_AUTH_URL="${GOOGLE_AUTH_URL:-https://api.siragpt.com/api/auth/google}"
EXPECTED_GOOGLE_REDIRECT_URI="${EXPECTED_GOOGLE_REDIRECT_URI:-https://api.siragpt.com/api/auth/google/callback}"

export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-https://api.siragpt.com/api}"
export NEXT_PUBLIC_URL="${NEXT_PUBLIC_URL:-https://siragpt.com}"

log() {
  printf '[deploy-production] %s\n' "$*"
}

fail() {
  printf '[deploy-production] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

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

handle_local_tracked_changes() {
  if git diff --quiet && git diff --cached --quiet; then
    return 0
  fi

  if [[ "$DEPLOY_AUTO_STASH_LOCAL_CHANGES" != "1" ]]; then
    fail "Git worktree has local tracked changes. Commit, stash, or discard them before deploy."
  fi

  local stash_name
  stash_name="deploy-production auto-stash before ${BRANCH} update $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "Git worktree has local tracked changes; saving recoverable stash: ${stash_name}"
  git status --short
  git stash push --message "$stash_name"

  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Git worktree still has local tracked changes after auto-stash."
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local attempts="${3:-30}"
  local delay="${4:-2}"
  local status=""

  for ((i = 1; i <= attempts; i += 1)); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
    if [[ "$status" == 2* || "$status" == 3* ]]; then
      log "$name is healthy ($status): $url"
      return 0
    fi
    sleep "$delay"
  done

  fail "$name did not become healthy after $((attempts * delay))s: $url (last status: ${status:-none})"
}

pm2_app_exists() {
  pm2 describe "$1" >/dev/null 2>&1
}

resolve_pm2_app() {
  local candidate detected
  local candidates="${PM2_APP_CANDIDATES:-${PM2_APP},sira-api,sira-api-backend,siragpt-api,siragpt-backend,backend}"

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
    fail "PM2 backend process not found. Set PM2_APP to the active backend process name."
  fi

  if [[ "$resolved_pm2_app" != "$PM2_APP" ]]; then
    log "PM2 backend default '$PM2_APP' not found; using detected process: $resolved_pm2_app"
  fi

  log "Restarting PM2 backend: $resolved_pm2_app"
  pm2 restart "$resolved_pm2_app" --update-env
}

read_google_redirect_uri() {
  local location
  location="$(curl -fsS -o /dev/null -w '%{redirect_url}' "$GOOGLE_AUTH_URL")"
  [[ -n "$location" ]] || fail "Google auth endpoint did not return a redirect URL"

  node -e '
    const location = process.argv[1];
    const parsed = new URL(location);
    process.stdout.write(parsed.searchParams.get("redirect_uri") || "");
  ' "$location"
}

require_command git
require_command docker
require_command pm2
require_command curl
require_command node

cd "$APP_DIR"

[[ -f "$COMPOSE_FILE" ]] || fail "Compose file not found: $APP_DIR/$COMPOSE_FILE"

handle_local_tracked_changes

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$BRANCH" ]]; then
  log "Switching branch: $current_branch -> $BRANCH"
  git checkout "$BRANCH"
fi

log "Updating $BRANCH from origin"
git fetch origin "$BRANCH"
git pull --ff-only origin "$BRANCH"

cleanup_docker_space

# Backend deps. The backend runs under PM2 on the host (not inside
# Docker), so new dependencies in backend/package.json aren't picked up
# unless we install them here. Without this step, adding a runtime dep
# (e.g. connect-redis) causes the backend to crash-loop on next restart
# with MODULE_NOT_FOUND. `npm install --omit=dev` is used (not `npm ci`)
# because the project historically allows lockfile drift; switch to
# `npm ci --omit=dev` once that's been audited.
log "Installing backend production dependencies"
(cd backend && npm install --omit=dev --no-audit --no-fund)

log "Building frontend Docker image with NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL"
docker compose -f "$COMPOSE_FILE" build "$FRONTEND_SERVICE"

log "Starting frontend container without backend dependencies"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$FRONTEND_SERVICE"

restart_pm2_backend

wait_for_http "API health" "$API_HEALTH_URL" 30 2
wait_for_http "Frontend login" "$FRONTEND_URL" 30 2

actual_redirect_uri="$(read_google_redirect_uri)"
if [[ "$actual_redirect_uri" != "$EXPECTED_GOOGLE_REDIRECT_URI" ]]; then
  fail "Google redirect_uri mismatch. Expected $EXPECTED_GOOGLE_REDIRECT_URI, got ${actual_redirect_uri:-empty}"
fi
log "Google OAuth redirect_uri is correct: $actual_redirect_uri"

log "Deployment complete at commit $(git rev-parse --short HEAD)"
