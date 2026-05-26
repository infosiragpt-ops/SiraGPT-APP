#!/usr/bin/env bash
#
# replit-init-from-token — given a Replit personal-access token and a
# repl id, this script does everything else:
#
#   1. Adds the `replit` git remote with the token URL.
#   2. Force-pushes `main` to the repl.
#   3. Persists the remote-without-token-in-config so subsequent
#      pushes work via the credential helper.
#
# Usage:
#
#   ./scripts/replit-init-from-token.sh <REPL_ID> <TOKEN>
#
# Find <REPL_ID>:
#   - Open the repl in the Replit IDE.
#   - The URL looks like https://replit.com/@username/repl-name
#     or https://replit.com/replit/<id>. The numeric/hash id is what
#     you pass here. If you only have the slug name, paste it; the
#     script will accept either form.
#
# Find <TOKEN>:
#   - https://replit.com/account#personal-access-tokens → New
#     token → scope "Read + Write" on this repl.
#
# Security notes:
#   - The token NEVER touches your shell history if you pipe it from a
#     password manager: `op read "op://Private/Replit token/password" |
#     xargs -I{} ./scripts/replit-init-from-token.sh <repl-id> {}`
#   - The token is stripped from the persisted git config; only the
#     authed URL is used for the one-time push.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <REPL_ID_OR_SLUG> <REPLIT_TOKEN>" >&2
  echo "example: $0 12345678-aaaa-bbbb-cccc xoxr-xxxxxxxxxxxxxxx" >&2
  exit 1
fi

REPL_ID="$1"
REPLIT_TOKEN="$2"

# Two URL shapes are valid: repls/<id>.git and @user/slug.git. Accept
# either and let Replit's server route it. The token goes in the
# username field (x-access-token) so it doesn't show up in `ps`.
if [[ "$REPL_ID" == *"/"* ]]; then
  REPL_PATH="$REPL_ID"
else
  REPL_PATH="repls/$REPL_ID"
fi

AUTHED_URL="https://x-access-token:${REPLIT_TOKEN}@replit.com/${REPL_PATH}.git"

echo "→ adding (or updating) 'replit' remote"
if git remote | grep -q "^replit$"; then
  git remote set-url replit "$AUTHED_URL"
else
  git remote add replit "$AUTHED_URL"
fi

echo "→ force-pushing main to Replit (overrides repl's working state)"
if git push replit main --force-with-lease; then
  echo "✓ pushed $(git rev-parse --short HEAD) to Replit"
else
  echo "✗ push failed. Verify:"
  echo "  · the token has Read+Write scope on this repl"
  echo "  · the repl id/slug is correct (current URL form: $REPL_PATH)"
  exit 1
fi

# Replace the URL stored in git config with a token-less form so it
# doesn't sit in .git/config forever. We rely on the credential
# helper (or a re-run of this script) for future pushes.
echo "→ scrubbing token from .git/config"
git remote set-url replit "https://replit.com/${REPL_PATH}.git"

cat <<'BANNER'

────────────────────────────────────────────────
✓ Replit remote configured and main pushed.

Future parallel pushes:
  ./scripts/push-all.sh main

If `git push replit main` asks for credentials in the future, re-run
this script with a fresh token, or configure your git credential
helper to remember the Replit token.
────────────────────────────────────────────────
BANNER
