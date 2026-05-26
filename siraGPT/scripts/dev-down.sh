#!/usr/bin/env bash
# dev-down.sh — Tear down the local SiraGPT dev environment.
#
# Steps:
#   1. Stop docker-compose services (Postgres, Redis, …) — keeps volumes.
#   2. Kill any orphaned node processes still bound to ports 3000 / 5000.
#
# Safe to re-run; missing processes / containers are non-fatal.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '\033[36m[dev-down]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[dev-down]\033[0m %s\n' "$*" >&2; }

# 1. Docker
if command -v docker >/dev/null 2>&1; then
  log "Stopping docker-compose services..."
  docker compose stop || warn "docker compose stop reported errors."
else
  warn "docker not found — skipping compose teardown."
fi

# 2. Orphan node procs on dev ports
kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      log "Killing process(es) on :$port → $pids"
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 1
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  elif command -v fuser >/dev/null 2>&1; then
    log "Killing process(es) on :$port via fuser"
    fuser -k "${port}/tcp" 2>/dev/null || true
  else
    warn "Neither lsof nor fuser available; cannot reclaim port $port."
  fi
}

kill_port 3000
kill_port 5000

log "Dev environment stopped."
