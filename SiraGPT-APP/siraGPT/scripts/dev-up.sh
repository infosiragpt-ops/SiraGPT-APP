#!/usr/bin/env bash
# dev-up.sh — Orchestrate the local SiraGPT dev environment.
#
# Steps:
#   1. Start Postgres + Redis (and any other infra services) via docker-compose
#      in detached mode.
#   2. Wait for Postgres to become healthy before running migrations.
#   3. Run `prisma migrate dev` from the backend workspace.
#   4. Seed the database (best-effort — non-fatal if no seed script).
#   5. Launch the Next.js frontend and the Express backend in parallel and
#      forward Ctrl-C to both children so the script exits cleanly.
#
# Idempotent — safe to re-run; docker-compose will reuse existing containers.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '\033[36m[dev-up]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev-up]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[dev-up]\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Infra
if ! command -v docker >/dev/null 2>&1; then
  die "docker not found in PATH — install Docker Desktop or the docker CLI."
fi

log "Starting Postgres + Redis via docker-compose..."
# Only bring up infra services; the app containers are started by npm run dev
# below so we can pick up hot-reload from the host filesystem.
docker compose up -d db redis 2>/dev/null || docker compose up -d db || true

# 2. Wait for Postgres
log "Waiting for Postgres to become healthy..."
for _ in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; then
    log "Postgres is ready."
    break
  fi
  sleep 1
done

# 3. Migrations
if [ -d "$ROOT_DIR/backend/prisma" ]; then
  log "Running prisma migrate dev..."
  (cd "$ROOT_DIR/backend" && npx prisma migrate dev --name dev_up --skip-seed) || warn "prisma migrate dev failed (continuing)."
else
  warn "No backend/prisma directory found; skipping migrations."
fi

# 4. Seed
if [ -f "$ROOT_DIR/backend/prisma/seed.js" ]; then
  log "Seeding database..."
  (cd "$ROOT_DIR/backend" && npm run seed) || warn "Seed step failed (continuing)."
fi

# 5. Parallel dev servers
log "Launching frontend (next dev :3000) and backend (nodemon :5000)..."

# shellcheck disable=SC2064
trap 'log "Caught SIGINT — stopping dev servers..."; kill 0 2>/dev/null || true; exit 0' INT TERM

(cd "$ROOT_DIR" && npm run dev) &
FRONT_PID=$!

(cd "$ROOT_DIR/backend" && npm run dev) &
BACK_PID=$!

log "frontend pid=$FRONT_PID  backend pid=$BACK_PID"
log "Ctrl-C to stop both."

wait $FRONT_PID $BACK_PID
