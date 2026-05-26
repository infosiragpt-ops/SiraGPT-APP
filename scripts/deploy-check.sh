#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# siraGPT — Pre-Deployment Checklist
# ──────────────────────────────────────────────────────────────
# Run before deploying to production. Checks common issues that
# can cause downtime or security incidents.
#
# Usage:
#   ./scripts/deploy-check.sh                 # check everything
#   ./scripts/deploy-check.sh --strict        # also check warnings as errors
#   ./scripts/deploy-check.sh --ci            # machine-readable output
# ──────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASS=0
FAIL=0
WARN=0
STRICT=false
CI=false

for arg in "$@"; do
    case "$arg" in
        --strict) STRICT=true ;;
        --ci) CI=true ;;
    esac
done

# Colors (disable for CI)
if [ "$CI" = true ]; then
    RED=""
    GREEN=""
    YELLOW=""
    RESET=""
else
    RED="\033[0;31m"
    GREEN="\033[0;32m"
    YELLOW="\033[0;33m"
    RESET="\033[0m"
fi

pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}✗${RESET} $1"; }
warn() { WARN=$((WARN+1)); echo -e "  ${YELLOW}⚠${RESET} $1"; }

echo "🔍 siraGPT Pre-Deployment Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── 1. Required files exist ────────────────────────────────
echo "📁 File structure"
[ -f "${PROJECT_ROOT}/.env" ] && pass ".env exists" || fail ".env is missing — create from .env.example"
[ -f "${PROJECT_ROOT}/docker-compose.prod.yml" ] && pass "docker-compose.prod.yml exists" || fail "docker-compose.prod.yml missing"
[ -f "${PROJECT_ROOT}/backend/index.js" ] && pass "backend/index.js exists" || fail "backend/index.js missing"
[ -f "${PROJECT_ROOT}/.github/workflows/ci.yml" ] && pass "CI workflow exists" || fail "CI workflow missing"

# ─── 2. Secret validation ───────────────────────────────────
echo ""
echo "🔐 Secrets"
if [ -f "${PROJECT_ROOT}/.env" ]; then
    JWT_SECRET=$(grep "^JWT_SECRET=" "${PROJECT_ROOT}/.env" | cut -d= -f2 | tr -d '"' || echo "")
    SESSION_SECRET=$(grep "^SESSION_SECRET=" "${PROJECT_ROOT}/.env" | cut -d= -f2 | tr -d '"' || echo "")

    if [ -z "$JWT_SECRET" ]; then
        fail "JWT_SECRET not set in .env"
    elif [ "$JWT_SECRET" = "change-this-to-a-long-random-string" ] || [ "$JWT_SECRET" = "your-super-secret-jwt-key-here" ]; then
        fail "JWT_SECRET is still a placeholder!"
    elif [ ${#JWT_SECRET} -lt 32 ]; then
        warn "JWT_SECRET is short (${#JWT_SECRET} chars, min 32)"
    else
        pass "JWT_SECRET set (${#JWT_SECRET} chars)"
    fi

    if [ -z "$SESSION_SECRET" ]; then
        fail "SESSION_SECRET not set in .env"
    elif [ ${#SESSION_SECRET} -lt 32 ]; then
        warn "SESSION_SECRET is short (${#SESSION_SECRET} chars, min 32)"
    else
        pass "SESSION_SECRET set (${#SESSION_SECRET} chars)"
    fi

    # Check for exposed API keys
    NEXT_PUBLIC_OPENAI=$(grep "^NEXT_PUBLIC_OPENAI_API_KEY=" "${PROJECT_ROOT}/.env" | cut -d= -f2 || echo "")
    if [ -n "$NEXT_PUBLIC_OPENAI" ]; then
        fail "NEXT_PUBLIC_OPENAI_API_KEY is set — this exposes your key to browsers!"
    fi
else
    fail ".env file not found — create from .env.example"
fi

# ─── 3. Docker checks ───────────────────────────────────────
echo ""
echo "🐳 Docker"
if command -v docker &>/dev/null; then
    pass "Docker installed"

    # Check if Docker images build
    if [ "$CI" != true ]; then
        echo "  (skipping build test — run 'docker compose build' manually)"
    fi

    # Check compose syntax
    if docker compose -f "${PROJECT_ROOT}/docker-compose.prod.yml" config &>/dev/null; then
        pass "docker-compose.prod.yml syntax valid"
    else
        fail "docker-compose.prod.yml has syntax errors"
    fi
else
    warn "Docker not installed on this machine"
fi

# ─── 4. Backend checks ──────────────────────────────────────
echo ""
echo "🖥️  Backend"
[ -f "${PROJECT_ROOT}/backend/package.json" ] && pass "package.json exists" || fail "package.json missing"
[ -f "${PROJECT_ROOT}/backend/prisma/schema.prisma" ] && pass "Prisma schema exists" || fail "Prisma schema missing"
[ -f "${PROJECT_ROOT}/backend/Dockerfile" ] && pass "Backend Dockerfile exists" || fail "Backend Dockerfile missing"

# Check critical dependencies
if [ -f "${PROJECT_ROOT}/backend/package.json" ]; then
    if grep -q "express-async-errors" "${PROJECT_ROOT}/backend/package.json"; then
        pass "express-async-errors installed"
    else
        fail "express-async-errors not installed!"
    fi
fi

# ─── 5. Frontend checks ─────────────────────────────────────
echo ""
echo "🎨 Frontend"
[ -f "${PROJECT_ROOT}/package.json" ] && pass "package.json exists" || fail "package.json missing"
[ -f "${PROJECT_ROOT}/next.config.mjs" ] && pass "Next.js config exists" || fail "next.config.mjs missing"
[ -f "${PROJECT_ROOT}/Dockerfile" ] && pass "Frontend Dockerfile exists" || fail "Frontend Dockerfile missing"

# Check error boundaries
[ -f "${PROJECT_ROOT}/app/error.tsx" ] && pass "app/error.tsx exists" || fail "app/error.tsx missing"
[ -f "${PROJECT_ROOT}/app/global-error.tsx" ] && pass "app/global-error.tsx exists" || warn "app/global-error.tsx missing"
[ -f "${PROJECT_ROOT}/app/not-found.tsx" ] && pass "app/not-found.tsx exists" || warn "app/not-found.tsx missing"
[ -f "${PROJECT_ROOT}/app/loading.tsx" ] && pass "app/loading.tsx exists" || warn "app/loading.tsx missing"

# ─── 6. CI checks ───────────────────────────────────────────
echo ""
echo "🔧 CI/CD"
[ -f "${PROJECT_ROOT}/.github/workflows/ci.yml" ] && pass "CI workflow exists" || fail "CI workflow missing"

# ─── 7. .gitignore check ────────────────────────────────────
echo ""
echo "📄 Git"
if [ -f "${PROJECT_ROOT}/.gitignore" ]; then
    if grep -q "\.env" "${PROJECT_ROOT}/.gitignore"; then
        pass ".env gitignored"
    else
        fail ".env not in .gitignore — secrets could be committed!"
    fi
    if grep -q "\.next" "${PROJECT_ROOT}/.gitignore"; then
        pass ".next gitignored"
    fi
else
    fail ".gitignore missing"
fi

# ─── 8. Scripts ─────────────────────────────────────────────
echo ""
echo "📜 Scripts"
[ -x "${PROJECT_ROOT}/scripts/generate-secrets.sh" ] && pass "generate-secrets.sh is executable" || warn "generate-secrets.sh not executable"
[ -x "${PROJECT_ROOT}/scripts/backup-db.sh" ] && pass "backup-db.sh is executable" || warn "backup-db.sh not executable"

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Results: ${GREEN}${PASS} passed${RESET}, ${RED}${FAIL} failed${RESET}, ${YELLOW}${WARN} warnings${RESET}"
echo ""

if [ "$FAIL" -gt 0 ]; then
    if [ "$STRICT" = true ] && [ "$WARN" -gt 0 ]; then
        FAIL=$((FAIL + WARN))
    fi
    echo "❌ ${FAIL} issue(s) found — fix before deploying."
    exit 1
elif [ "$WARN" -gt 0 ]; then
    echo "⚠️  ${WARN} warning(s) — review before production deploy."
    exit 0
else
    echo "✅ All checks passed — ready to deploy!"
    exit 0
fi
