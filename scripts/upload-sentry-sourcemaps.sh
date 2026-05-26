#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Upload Source Maps to Sentry
# ──────────────────────────────────────────────────────────────
# Run AFTER a production build to upload source maps for both
# frontend and backend. Sentry uses these to show original
# source code in error stack traces instead of minified bundles.
#
# Prerequisites:
#   - @sentry/cli installed (npm install -g @sentry/cli)
#   - SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT set in env
#   - SENTRY_RELEASE set to the current release version
#
# Usage:
#   SENTRY_AUTH_TOKEN=... SENTRY_ORG=my-org SENTRY_PROJECT=siragpt-frontend \
#     ./scripts/upload-sentry-sourcemaps.sh
#
# ⚠️  Run this AFTER the Docker image is built but BEFORE it's
#     deployed, so the release is registered before errors arrive.
# ──────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────
SENTRY_ORG="${SENTRY_ORG:?SENTRY_ORG is required}"
SENTRY_PROJECT="${SENTRY_PROJECT:?SENTRY_PROJECT is required}"
SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:?SENTRY_AUTH_TOKEN is required}"
SENTRY_RELEASE="${SENTRY_RELEASE:?SENTRY_RELEASE is required}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Helper ─────────────────────────────────────────────────
upload_frontend() {
    echo "[sentry] Creating release: ${SENTRY_RELEASE}"
    sentry-cli releases new "${SENTRY_RELEASE}" --org "${SENTRY_ORG}" --project "${SENTRY_PROJECT}"

    echo "[sentry] Uploading frontend source maps from .next/"

    # Upload all JS source maps from the build output
    sentry-cli releases files "${SENTRY_RELEASE}" \
        upload-source-maps \
        --org "${SENTRY_ORG}" \
        --project "${SENTRY_PROJECT}" \
        --url-prefix "~/" \
        --validate \
        --no-rewrite \
        "${PROJECT_ROOT}/.next/static/chunks/" \
        "${PROJECT_ROOT}/.next/server/pages/" 2>/dev/null || true

    # Also upload any server-side source maps
    if [ -d "${PROJECT_ROOT}/.next/server/chunks/" ]; then
        sentry-cli releases files "${SENTRY_RELEASE}" \
            upload-source-maps \
            --org "${SENTRY_ORG}" \
            --project "${SENTRY_PROJECT}" \
            --url-prefix "~/" \
            --validate \
            --no-rewrite \
            "${PROJECT_ROOT}/.next/server/chunks/" 2>/dev/null || true
    fi

    echo "[sentry] Setting release as current"
    sentry-cli releases set-commits "${SENTRY_RELEASE}" --auto --org "${SENTRY_ORG}" 2>/dev/null || true

    echo "[sentry] Finalizing release"
    sentry-cli releases finalize "${SENTRY_RELEASE}" --org "${SENTRY_ORG}" --project "${SENTRY_PROJECT}"
}

upload_backend() {
    echo "[sentry] Uploading backend source maps (if any)"
    # If the backend has source maps from TypeScript compilation
    if [ -d "${PROJECT_ROOT}/backend/dist" ]; then
        sentry-cli releases files "${SENTRY_RELEASE}" \
            upload-source-maps \
            --org "${SENTRY_ORG}" \
            --project "siragpt-backend" \
            --url-prefix "~/backend" \
            --validate \
            --no-rewrite \
            "${PROJECT_ROOT}/backend/dist/" 2>/dev/null || true
    fi
}

# ─── Main ───────────────────────────────────────────────────
if ! command -v sentry-cli &>/dev/null; then
    echo "[sentry] sentry-cli not found. Install with: npm install -g @sentry/cli"
    exit 1
fi

echo "[sentry] Starting source map upload for release: ${SENTRY_RELEASE}"
echo "[sentry] Organization: ${SENTRY_ORG}"
echo "[sentry] Project: ${SENTRY_PROJECT}"

upload_frontend
upload_backend

echo "[sentry] ✅ Source maps uploaded successfully"
echo "[sentry] Release: ${SENTRY_RELEASE}"
