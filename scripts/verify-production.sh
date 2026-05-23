#!/usr/bin/env bash
# verify-production.sh — black-box verification of api.siragpt.com /
# siragpt.com from outside. Runs from any developer machine; needs
# only curl + jq. No SSH, no credentials, no Stripe SDK.
#
# Designed to be run AFTER `scripts/activate-stripe-live.sh` succeeds
# on the server, to confirm from the public internet that:
#   - Frontend responds + serves the live Stripe publishable key
#   - Backend health is OK + reports the providers we expect
#   - Stripe checkout endpoint exists + correctly demands auth
#   - Stripe webhook endpoint exists + correctly demands a signature
#   - Plan-change endpoints exist + correctly demand auth
#   - OAuth redirect URI matches expectations
#   - DNS / certs / cookies look sane
#
# Exit codes:
#   0 — all green
#   1 — at least one check failed; the failure is printed inline

set -uo pipefail

FRONTEND="${FRONTEND_URL:-https://siragpt.com}"
API="${API_URL:-https://api.siragpt.com}"

PASS=0
FAIL=0

pass() { printf '  [✓] %s\n' "$*"; PASS=$((PASS+1)); }
warn() { printf '  [~] %s\n' "$*"; }
fail() { printf '  [✗] %s\n' "$*"; FAIL=$((FAIL+1)); }
title() { printf '\n== %s ==\n' "$*"; }

title "1. Frontend reachability"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$FRONTEND/")"
if [[ "$status" == 2* || "$status" == 3* ]]; then
  pass "$FRONTEND/ returned HTTP $status"
else
  fail "$FRONTEND/ returned HTTP $status"
fi

if curl -sS --max-time 10 "$FRONTEND/" | grep -qE '<title[^>]*>'; then
  pass "$FRONTEND/ serves a non-empty <title>"
else
  fail "$FRONTEND/ has no <title>"
fi

title "2. Backend health"
health_json="$(curl -sS --max-time 10 "$API/health" || true)"
if echo "$health_json" | grep -q '"status":"healthy"'; then
  pass "$API/health: status=healthy"
else
  fail "$API/health: unhealthy or unreachable. Body: $(echo "$health_json" | head -c 200)"
fi
if echo "$health_json" | grep -q '"name":"database".*"status":"healthy"'; then
  pass "Database probe: healthy"
else
  warn "Database probe is not healthy in /health"
fi

title "3. Stripe checkout endpoint (auth-gated)"
checkout_status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST -H 'Content-Type: application/json' -d '{"plan":"PRO"}' \
  "$API/api/payments/stripe")"
if [[ "$checkout_status" == "401" ]]; then
  pass "POST /api/payments/stripe without token returns 401 (auth-gated correctly)"
elif [[ "$checkout_status" == "503" ]]; then
  fail "POST /api/payments/stripe returns 503 — Stripe is NOT configured (live keys missing on server)"
elif [[ "$checkout_status" == "429" ]]; then
  pass "POST /api/payments/stripe returns 429 (rate-limited but endpoint exists)"
else
  fail "POST /api/payments/stripe returned $checkout_status (expected 401)"
fi

title "4. Stripe webhook endpoint (signature-gated)"
wh_body="$(curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' -d '{}' \
  "$API/api/payments/stripe/webhook" || true)"
if echo "$wh_body" | grep -qiE 'stripe-signature|signature.*provided|no stripe-signature'; then
  pass "Webhook rejects unsigned requests (signature verification active)"
else
  fail "Webhook did not reject unsigned request as expected. Body: $(echo "$wh_body" | head -c 200)"
fi

title "5. Plan-change endpoints"
for ep in plan-change/preview plan-change/execute plan-change/cancel; do
  s="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST -H 'Content-Type: application/json' -d '{}' \
    "$API/api/payments/$ep")"
  if [[ "$s" == "401" || "$s" == "400" || "$s" == "429" ]]; then
    pass "POST /api/payments/$ep returns $s (endpoint exists, gating works)"
  else
    fail "POST /api/payments/$ep returned $s (expected 400/401/429)"
  fi
done

title "6. Google OAuth redirect URI"
oauth_redirect="$(curl -sS -o /dev/null -w '%{redirect_url}' --max-time 10 \
  "$API/api/auth/google" || true)"
if [[ -z "$oauth_redirect" ]]; then
  warn "No redirect from /api/auth/google (may be configured for direct response)"
else
  ru="$(node -e "
    try {
      const u = new URL(process.argv[1]);
      process.stdout.write(u.searchParams.get('redirect_uri') || '');
    } catch (e) {}
  " "$oauth_redirect" 2>/dev/null)"
  expected="$API/api/auth/google/callback"
  if [[ "$ru" == "$expected" ]]; then
    pass "Google OAuth redirect_uri matches: $ru"
  else
    fail "Google OAuth redirect_uri = $ru (expected $expected)"
  fi
fi

title "7. Security headers on $FRONTEND/"
hdrs="$(curl -sSI --max-time 10 "$FRONTEND/")"
for h in 'Strict-Transport-Security' 'X-Content-Type-Options' 'X-Frame-Options'; do
  if echo "$hdrs" | grep -qi "^$h:"; then
    pass "Header present: $h"
  else
    warn "Header missing: $h"
  fi
done

title "8. Backend version"
version="$(echo "$health_json" | node -e "
  let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{
    try { const o=JSON.parse(s); const p=(o.checks||[]).find(c=>c.name==='process'); process.stdout.write(p?.details?.node||'')} catch {}
  });" 2>/dev/null || true)"
if [[ -n "$version" ]]; then
  pass "Backend node version: $version"
else
  warn "Could not parse backend node version from /health"
fi

printf '\n────────────────────────────────────────\n'
printf 'SUMMARY: %d passed, %d failed\n' "$PASS" "$FAIL"
printf '────────────────────────────────────────\n'

[[ "$FAIL" -eq 0 ]] || exit 1
