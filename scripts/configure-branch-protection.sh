#!/usr/bin/env bash
# F5 PR22 — Apply the GitHub branch-protection rule for `main`.
#
# Reads the canonical context list from
# docs/operations/BRANCH_PROTECTION.md and dispatches the GitHub API
# call via `gh api`. Idempotent — re-running overwrites the rule.
#
# Usage:
#   bash scripts/configure-branch-protection.sh
#   bash scripts/configure-branch-protection.sh --dry-run

set -euo pipefail

REPO="${REPO:-SiraGPT-ORg/siraGPT}"
DRY_RUN=0
if [[ "${1-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not installed. brew install gh" >&2
  exit 2
fi

# Canonical required check contexts (must match the table in
# docs/operations/BRANCH_PROTECTION.md).
CONTEXTS=(
  "CI / Frontend · build"
  "CI / Backend · prisma + boot smoke test (shard 1/4)"
  "CI / Backend · prisma + boot smoke test (shard 2/4)"
  "CI / Backend · prisma + boot smoke test (shard 3/4)"
  "CI / Backend · prisma + boot smoke test (shard 4/4)"
  "CI / Security · npm audit"
  "CI / Secret scan · gitleaks"
  "CodeQL / Analyze (javascript-typescript)"
)

# Build the JSON payload.
contexts_json=$(printf '"%s",' "${CONTEXTS[@]}" | sed 's/,$//')
payload=$(cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": [${contexts_json}]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": true
}
EOF
)

echo "==> Configuring branch protection on $REPO main"
echo "$payload" | jq . 2>/dev/null || echo "$payload"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would PUT /repos/$REPO/branches/main/protection"
  exit 0
fi

echo "$payload" | gh api \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  "/repos/$REPO/branches/main/protection" \
  --input -

echo "==> Verifying"
gh api "/repos/$REPO/branches/main/protection" \
  --jq '{enforce_admins:.enforce_admins.enabled,
         allow_force_pushes:.allow_force_pushes.enabled,
         allow_deletions:.allow_deletions.enabled,
         required_status_checks_contexts:.required_status_checks.contexts}'

echo "✓ branch protection applied"
