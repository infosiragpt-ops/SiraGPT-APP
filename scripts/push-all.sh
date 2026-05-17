#!/usr/bin/env bash
#
# push-all — push the current branch to GitHub (origin) AND Replit
# (replit remote) in parallel. The Replit remote is optional; if
# it is not configured, the script pushes to GitHub only and exits
# cleanly so existing workflows aren't broken.
#
# Usage:
#   ./scripts/push-all.sh                  # push current branch
#   ./scripts/push-all.sh main             # push specific branch
#   ./scripts/push-all.sh main --force     # force-push to both
#
# Configuration:
#   - GitHub: `origin` must point at https://github.com/SiraGPT-ORg/siraGPT
#     (already set in this repo).
#   - Replit: add the Repl's git URL as a remote called `replit`.
#     The URL is shown inside the Replit IDE under "Version Control →
#     Connect with Git". A typical form is:
#
#       https://<replit-user>:<personal-access-token>@replit.com/repls/<id>.git
#
#     One-time setup:
#
#       git remote add replit <URL_FROM_REPLIT_UI>
#
#     Personal access tokens are managed at:
#       https://replit.com/account#personal-access-tokens
#
# Behaviour:
#   - Both pushes run concurrently. A failure in either is surfaced
#     (the script exits non-zero) but both pushes are awaited so you
#     can see what happened on each side.
#   - Without a `replit` remote, the script just runs `git push origin`.

set -euo pipefail

BRANCH=${1:-$(git rev-parse --abbrev-ref HEAD)}
shift 2>/dev/null || true
EXTRA_ARGS=("$@")

echo "→ pushing $BRANCH to origin (GitHub)..."
git push origin "$BRANCH" "${EXTRA_ARGS[@]}" &
GH_PID=$!

REPL_PID=""
if git remote | grep -q "^replit$"; then
  echo "→ pushing $BRANCH to replit (Replit)..."
  git push replit "$BRANCH" "${EXTRA_ARGS[@]}" &
  REPL_PID=$!
else
  echo "→ no 'replit' remote configured — skipping (run \`git remote add replit <url>\`)."
fi

GH_RC=0
REPL_RC=0

wait "$GH_PID" || GH_RC=$?
if [ -n "$REPL_PID" ]; then
  wait "$REPL_PID" || REPL_RC=$?
fi

echo
if [ "$GH_RC" -eq 0 ]; then
  echo "✓ GitHub: pushed $BRANCH"
else
  echo "✗ GitHub: push failed (exit $GH_RC)"
fi

if [ -n "$REPL_PID" ]; then
  if [ "$REPL_RC" -eq 0 ]; then
    echo "✓ Replit: pushed $BRANCH"
  else
    echo "✗ Replit: push failed (exit $REPL_RC)"
  fi
fi

# Exit non-zero if either side failed so CI / pre-push hooks notice.
if [ "$GH_RC" -ne 0 ] || [ "$REPL_RC" -ne 0 ]; then
  exit 1
fi
