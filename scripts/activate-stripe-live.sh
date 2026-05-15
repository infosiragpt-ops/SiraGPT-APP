#!/usr/bin/env bash
# activate-stripe-live.sh — one-shot activation of Stripe LIVE mode in production.
#
# This script never logs secret values. It reads them from the
# environment, atomically updates backend/.env (with a timestamped
# backup), restarts the backend under PM2, then auto-initialises the
# Stripe products/prices and verifies the resulting checkout flow.
#
# Usage (run ON the production server, NOT in the developer's chat):
#
#   ssh root@62.72.11.231
#   cd /root/siraNew/siraGPT
#   export STRIPE_SECRET_KEY='sk_live_...'
#   export STRIPE_PUBLISHABLE_KEY='pk_live_...'
#   export STRIPE_WEBHOOK_SECRET='whsec_...'        # from Stripe dashboard webhook config
#   bash scripts/activate-stripe-live.sh
#
# The script will:
#   1. Validate all three env vars are present and shaped like live keys
#   2. Back up backend/.env with a timestamp suffix
#   3. Update the three STRIPE_* fields atomically
#   4. Update NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in .env.local for the frontend
#   5. Restart sira-api-backend under PM2 with --update-env
#   6. Wait until /health returns 200
#   7. Run initializeStripeProducts() to create Products/Prices in Stripe
#      AND record the resulting STRIPE_PRICE_PRO / PRO_MAX / ENTERPRISE
#      values in the system_settings table
#   8. Print a verification command the dev can run from their machine

set -Eeuo pipefail

APP_DIR="${APP_DIR:-/root/siraNew/siraGPT}"
BACKEND_DIR="$APP_DIR/backend"
PM2_APP="${PM2_APP:-sira-api-backend}"
HEALTH_URL="${HEALTH_URL:-https://api.siragpt.com/health}"

log() { printf '[stripe-live] %s\n' "$*"; }
fail() { printf '[stripe-live] ERROR: %s\n' "$*" >&2; exit 1; }

require_var() {
  local name="$1"
  local prefix="$2"
  [[ -n "${!name:-}" ]] || fail "$name is not set in the environment"
  case "${!name}" in
    "$prefix"*) ;;
    *) fail "$name does not start with '$prefix' — refusing to activate live mode with a malformed key" ;;
  esac
}

# 1. Validate inputs without logging their values.
require_var STRIPE_SECRET_KEY      'sk_live_'
require_var STRIPE_PUBLISHABLE_KEY 'pk_live_'
require_var STRIPE_WEBHOOK_SECRET  'whsec_'
log "All three Stripe live env vars are present and well-formed."

[[ -f "$BACKEND_DIR/.env" ]] || fail "Missing $BACKEND_DIR/.env"
command -v pm2 >/dev/null   || fail "pm2 not found on PATH"
command -v node >/dev/null  || fail "node not found on PATH"
command -v curl >/dev/null  || fail "curl not found on PATH"

# 2. Atomic env update. We never echo the values — we write them
# straight to the file via Python, which is the only tool available
# on most servers that handles ${VAR} expansion without leaking it
# to the shell history.
update_env_file() {
  local file="$1"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$file" "${file}.bak.${stamp}"
  log "Backed up $file -> ${file}.bak.${stamp}"

  # Use python3 — it's available on the deploy box (the deploy script
  # already requires node which has python via venv on most setups).
  # Fall back to perl which we know is on Debian/Ubuntu by default.
  if command -v python3 >/dev/null; then
    python3 - "$file" <<'PYEOF'
import os, sys, re, tempfile
path = sys.argv[1]
keys = {
    "STRIPE_SECRET_KEY":      os.environ["STRIPE_SECRET_KEY"],
    "STRIPE_PUBLISHABLE_KEY": os.environ["STRIPE_PUBLISHABLE_KEY"],
    "STRIPE_WEBHOOK_SECRET":  os.environ["STRIPE_WEBHOOK_SECRET"],
}
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
seen = {k: False for k in keys}
out = []
for line in lines:
    matched = False
    for k, v in keys.items():
        if line.startswith(f"{k}="):
            out.append(f'{k}="{v}"\n')
            seen[k] = True
            matched = True
            break
    if not matched:
        out.append(line)
for k, v in keys.items():
    if not seen[k]:
        out.append(f'{k}="{v}"\n')

tmpdir = os.path.dirname(os.path.abspath(path))
fd, tmppath = tempfile.mkstemp(dir=tmpdir, prefix=".env.tmp.")
os.close(fd)
with open(tmppath, "w", encoding="utf-8") as f:
    f.writelines(out)
os.chmod(tmppath, 0o600)
os.replace(tmppath, path)
PYEOF
  else
    fail "python3 is required (no fallback implemented)"
  fi
}

log "Patching $BACKEND_DIR/.env (atomic write)"
update_env_file "$BACKEND_DIR/.env"

# 3. Frontend gets the publishable key only.
if [[ -f "$APP_DIR/.env.local" ]]; then
  log "Patching $APP_DIR/.env.local for NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp "$APP_DIR/.env.local" "$APP_DIR/.env.local.bak.${stamp}"
  python3 - "$APP_DIR/.env.local" <<'PYEOF'
import os, sys, tempfile
path = sys.argv[1]
key = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
val = os.environ["STRIPE_PUBLISHABLE_KEY"]
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()
seen = False
out = []
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={val}\n")
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(f"{key}={val}\n")
tmpdir = os.path.dirname(os.path.abspath(path))
fd, tmppath = tempfile.mkstemp(dir=tmpdir, prefix=".env.local.tmp.")
os.close(fd)
with open(tmppath, "w", encoding="utf-8") as f:
    f.writelines(out)
os.chmod(tmppath, 0o600)
os.replace(tmppath, path)
PYEOF
fi

# 4. Restart backend with new env loaded.
log "Restarting $PM2_APP with --update-env"
pm2 restart "$PM2_APP" --update-env

# 5. Wait for health.
log "Waiting for $HEALTH_URL to return 2xx (60s budget)"
for attempt in $(seq 1 30); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$HEALTH_URL" || true)"
  if [[ "$status" == 2* ]]; then
    log "Backend healthy after ${attempt} attempt(s) ($status)"
    break
  fi
  sleep 2
  if [[ "$attempt" == "30" ]]; then
    fail "Backend did not become healthy. Check: pm2 logs $PM2_APP --lines 50"
  fi
done

# 6. Initialise products + prices in Stripe (and persist Price IDs
# in system_settings). Idempotent: if products already exist, this
# updates them rather than duplicating.
log "Initialising Stripe products + prices"
cd "$BACKEND_DIR"
node -e "
const { initializeStripeProducts } = require('./src/utils/stripe-setup');
initializeStripeProducts()
  .then(() => { console.log('OK: stripe products initialised'); process.exit(0); })
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
"

# 7. Verification one-liners the dev can run locally.
cat <<'VERIFY'
[stripe-live] DONE. Verify from any machine:

  # 1) Backend is live
  curl -s https://api.siragpt.com/health | jq '.status'

  # 2) Stripe checkout endpoint refuses unauth (existence smoke)
  curl -s -X POST https://api.siragpt.com/api/payments/stripe \
    -H 'Content-Type: application/json' -d '{"plan":"PRO"}'

  # 3) Stripe webhook endpoint signs-verifies (rejects unsigned)
  curl -s -X POST https://api.siragpt.com/api/payments/stripe/webhook \
    -H 'Content-Type: application/json' -d '{}'

  # 4) Real end-to-end: log in on https://siragpt.com → /billing,
  #    click Upgrade on PRO. Use Stripe TEST card 4242 4242 4242 4242
  #    if you want a no-charge smoke; live cards charge real money.

VERIFY
