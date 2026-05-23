#!/bin/bash
# Post-merge setup — runs after a task is merged into main.
# Must be idempotent, non-interactive, and fail fast.
set -euo pipefail

echo "[post-merge] installing root deps"
npm install --no-audit --no-fund --prefer-offline

if [ -f backend/package.json ]; then
  echo "[post-merge] installing backend deps"
  npm --prefix backend install --no-audit --no-fund --prefer-offline
fi

if [ -f backend/prisma/schema.prisma ]; then
  echo "[post-merge] regenerating prisma client"
  npm --prefix backend exec -- prisma generate --schema backend/prisma/schema.prisma
fi

echo "[post-merge] done"
