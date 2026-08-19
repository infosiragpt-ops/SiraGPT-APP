#!/usr/bin/env bash
# smoke-deployment.sh — post-deploy smoke gate. Hits the critical surface
# of a running siraGPT API and exits non-zero on any failure. Intended to
# run after a deploy completes, before traffic is fully cut over.
#
# Usage:
#   BASE_URL=https://api.siragpt.com \
#   TEST_EMAIL=smoke@example.com \
#   TEST_PASSWORD=... \
#   bash scripts/smoke-deployment.sh
#
# Or for a local check:
#   BASE_URL=http://localhost:5000 bash scripts/smoke-deployment.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000}"
TEST_EMAIL="${TEST_EMAIL:-}"
TEST_PASSWORD="${TEST_PASSWORD:-}"
TIMEOUT="${SMOKE_TIMEOUT_SECS:-10}"

failures=0
note() { printf '· %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; failures=$((failures + 1)); }
ok()   { printf '✓ %s\n' "$1"; }

probe() {
  local name="$1" path="$2" expected_status="${3:-200}"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$BASE_URL$path" || echo 000)"
  if [[ "$status" == "$expected_status" || "$status" == 2?? ]]; then
    ok "$name → $status"
  else
    fail "$name → $status (expected $expected_status)"
  fi
}

note "Smoke target: $BASE_URL"

probe "GET /health/live"  "/health/live"  200
probe "GET /health/ready" "/health/ready" 200

# Public providers list (cached endpoint)
probe "GET /api/scientific-search/providers" "/api/scientific-search/providers" 200

# Auth flow if credentials provided
if [[ -n "$TEST_EMAIL" && -n "$TEST_PASSWORD" ]]; then
  resp="$(curl -s --max-time "$TIMEOUT" -X POST "$BASE_URL/api/auth/login" \
           -H 'Content-Type: application/json' \
           -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" || true)"
  token="$(printf '%s' "$resp" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -1)"
  if [[ -n "$token" ]]; then
    ok "POST /api/auth/login → token issued"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
             -H "Authorization: Bearer $token" "$BASE_URL/api/auth/me")"
    if [[ "$code" == "200" ]]; then ok "GET /api/auth/me → 200"; else fail "GET /api/auth/me → $code"; fi
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
             -H "Authorization: Bearer $token" "$BASE_URL/api/chats")"
    if [[ "$code" == "200" ]]; then ok "GET /api/chats → 200"; else fail "GET /api/chats → $code"; fi
  else
    fail "POST /api/auth/login → token missing in response"
  fi
else
  note "Skipped auth flow (TEST_EMAIL / TEST_PASSWORD not set)"
fi

if (( failures > 0 )); then
  printf '\nSmoke failed with %d error(s)\n' "$failures" >&2
  exit 1
fi
printf '\nAll smoke checks green.\n'
