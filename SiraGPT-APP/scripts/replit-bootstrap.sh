#!/usr/bin/env bash
#
# replit-bootstrap — paste-and-run setup for the Replit terminal.
# This is the ONE command the user runs inside Replit's `~/workspace$`
# shell to clone siraGPT and prepare it for the IDE's Run button.
#
# Usage from inside Replit:
#
#   curl -fsSL https://raw.githubusercontent.com/SiraGPT-ORg/siraGPT/main/scripts/replit-bootstrap.sh | bash
#
# After this finishes, the Replit IDE shows the project tree and the
# Run button executes `.replit`'s `run = "npm run dev"`.

set -euo pipefail

REPO_URL="https://github.com/SiraGPT-ORg/siraGPT.git"
WORKDIR="${HOME}/workspace"

echo "→ siraGPT bootstrap for Replit"
echo "  repo: $REPO_URL"
echo "  cwd:  $WORKDIR"
echo

# Replit ships an empty workspace by default. Switch into it and
# initialise an empty repo so `git fetch` has somewhere to land.
mkdir -p "$WORKDIR"
cd "$WORKDIR"

if [ -d .git ]; then
  echo "→ existing git repo detected — refreshing from $REPO_URL"
  if git remote | grep -q "^origin$"; then
    git remote set-url origin "$REPO_URL"
  else
    git remote add origin "$REPO_URL"
  fi
else
  echo "→ initialising new git repo"
  git init -q -b main
  git remote add origin "$REPO_URL"
fi

echo "→ fetching main (this is a fresh clone-equivalent, may take ~30s)"
git fetch --depth=1 origin main

# `--ours` ddoesn't help on initial fetch; reset is fine since the
# workspace is meant to be a mirror of main, not a separate branch.
git reset --hard FETCH_HEAD
echo "✓ checked out: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Install deps. `npm ci` is faster + reproducible because there's a
# lockfile in the repo.
echo
echo "→ installing Node deps (npm ci, ~60–120s on first run)"
if [ -f package-lock.json ]; then
  npm ci --prefer-offline --no-audit --no-fund
else
  npm install --prefer-offline --no-audit --no-fund
fi

# Seed `.env` from the example if one exists so the first Run doesn't
# fail with "missing env var" errors.
if [ -f .env.example ] && [ ! -f .env ]; then
  cp .env.example .env
  echo "→ seeded .env from .env.example (edit it in the Replit Secrets pane)"
fi

# Prisma client generation — required by the backend AT module-load
# time. Cheap when already generated, so always run it.
if [ -d backend/prisma ]; then
  echo "→ generating Prisma client for backend"
  (cd backend && npx prisma generate --schema=prisma/schema.prisma) || \
    echo "  ! Prisma generate failed — set DATABASE_URL in Replit Secrets and re-run"
fi

cat <<'BANNER'

────────────────────────────────────────────────
✓ siraGPT bootstrap complete.

Next steps inside Replit:

  1. Open the Secrets panel (left sidebar → 🔒) and set:
       NEXT_PUBLIC_API_URL   → your backend URL (or http://localhost:5000/api for local)
       JWT_SECRET            → any 32+ char random string
       DATABASE_URL          → Postgres connection string for backend
     Optional but recommended:
       OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, GEMINI_API_KEY

  2. Click ▶ Run. Replit will execute `npm run dev` and forward
     localhost:3000 to a public HTTPS URL.

For the parallel-push setup back to GitHub, see REPLIT.md.
────────────────────────────────────────────────
BANNER
