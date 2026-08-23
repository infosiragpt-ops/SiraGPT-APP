#!/usr/bin/env bash
# dev-up.sh — Orchestrate the local SiraGPT dev environment.
#
# Steps:
#   0. Generate a minimal valid .env.local on first run (secrets + local DB).
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

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# 0. First-run env: the backend requires PRISMA_DATABASE_URL at boot and
#    rejects weak JWT/SESSION secrets. dotenv does NOT expand ${VAR}, so the
#    generated file uses plain localhost values instead of templates.
if [ ! -f "$ROOT_DIR/.env.local" ] && [ ! -f "$ROOT_DIR/backend/.env.local" ]; then
  log "No .env.local found — generating one with local dev defaults..."
  cat > "$ROOT_DIR/.env.local" <<EOF
NODE_ENV=development
PORT=5000

POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=siragpt

PRISMA_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/siragpt
DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/siragpt
DATABASE_URL=

REDIS_URL=redis://localhost:6379

JWT_SECRET=$(random_hex)
SESSION_SECRET=$(random_hex)

CORS_ORIGINS=http://localhost:3000
TRUST_PROXY_HOPS=0
FRONTEND_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:5000/api
NEXT_PUBLIC_URL=http://localhost:3000

SESSION_TOKEN_HASH_MODE=compat
SESSION_TOKEN_HASH_COMPAT_DRAINED=1
EOF
  log "Created .env.local — add your model API keys there when you need them."
fi

BACKEND_PORT="${BACKEND_PORT:-5000}"

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
  if docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then
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
log "Launching frontend (next dev :3000) and backend (nodemon :${BACKEND_PORT})..."

# shellcheck disable=SC2064
trap 'log "Caught SIGINT — stopping dev servers..."; kill 0 2>/dev/null || true; exit 0' INT TERM

# Keep the frontend's /api proxy aimed at wherever this script actually starts
# the backend, even if PORT was customized.
export BACKEND_INTERNAL_URL="http://127.0.0.1:${BACKEND_PORT}"
export BACKEND_PORT

(cd "$ROOT_DIR" && npm run dev) &
FRONT_PID=$!

(cd "$ROOT_DIR/backend" && PORT="$BACKEND_PORT" npm run dev) &
BACK_PID=$!

log "frontend pid=$FRONT_PID  backend pid=$BACK_PID"
log "Ctrl-C to stop both."

wait $FRONT_PID $BACK_PID
