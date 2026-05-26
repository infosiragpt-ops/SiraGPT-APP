#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Secret Generator
# ──────────────────────────────────────────────────────────────
# Generates cryptographically strong secrets for production use.
# Run this once when setting up a new environment.
#
# Usage:
#   chmod +x scripts/generate-secrets.sh
#   ./scripts/generate-secrets.sh
#   ./scripts/generate-secrets.sh | tee -a .env
# ──────────────────────────────────────────────────────────────

set -euo pipefail

echo "# ─── siraGPT Auto-generated Secrets ───"
echo "# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# 64-char hex strings (256 bits entropy each)
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat <<SECRETS
# ── JWT (token signing) ──
JWT_SECRET="${JWT_SECRET}"

# ── Session (cookie encryption) ──
SESSION_SECRET="${SESSION_SECRET}"

# ── Encryption (at-rest data encryption) ──
ENCRYPTION_KEY="${ENCRYPTION_KEY}"
SECRETS

echo ""
echo "# ✅ Secrets generated. Copy the lines above into your .env file."
echo "# Store these securely — they cannot be recovered if lost."
echo "# Rotating secrets invalidates all active sessions and encrypted data."
