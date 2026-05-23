#!/usr/bin/env bash
# check-secrets.sh — block accidental secret commits.
#
# Receives a list of staged file paths on the command line (lint-staged
# passes one argument per matched file). Greps each file for a small set
# of high-signal credential patterns and exits non-zero on the first hit.
#
# Patterns are intentionally narrow to keep false-positive noise low; this
# is a backstop, not a full DLP scanner. For broader coverage, run
# `gitleaks` or `trufflehog` in CI.

set -euo pipefail

if [[ $# -eq 0 ]]; then
  exit 0
fi

# Each entry is "<label>::<extended-regex>".
PATTERNS=(
  'AWS Access Key ID::AKIA[0-9A-Z]{16}'
  'PEM private key (RSA)::-----BEGIN RSA PRIVATE KEY-----'
  'PEM private key (OpenSSH)::-----BEGIN OPENSSH PRIVATE KEY-----'
  'PEM private key (generic)::-----BEGIN PRIVATE KEY-----'
  'OpenAI API key::sk-[A-Za-z0-9_-]{32,}'
  'Anthropic API key::sk-ant-[A-Za-z0-9_-]{32,}'
  'Stripe live secret::sk_live_[A-Za-z0-9]{16,}'
  'Stripe restricted::rk_live_[A-Za-z0-9]{16,}'
  'GitHub PAT (classic)::ghp_[A-Za-z0-9]{36}'
  'GitHub PAT (fine-grained)::github_pat_[A-Za-z0-9_]{60,}'
  'Google API key::AIza[0-9A-Za-z_-]{35}'
  'Slack bot token::xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}'
)

FAIL=0
for file in "$@"; do
  # Skip binary/large/non-existent files.
  [[ -f "$file" ]] || continue
  # Skip lockfiles, vendored snapshots, and the secret-checker itself.
  case "$file" in
    *package-lock.json|*pnpm-lock.yaml|*yarn.lock) continue ;;
    *node_modules/*|*.next/*|*coverage/*|*dist/*|*build/*) continue ;;
    *scripts/check-secrets.sh) continue ;;
    # CI workflows carry inert fixtures (sk-ci-dummy-*, sk_test_*) — skip.
    *.github/workflows/*) continue ;;
  esac

  for entry in "${PATTERNS[@]}"; do
    label="${entry%%::*}"
    regex="${entry#*::}"
    if grep -E -n -I --binary-files=without-match -- "$regex" "$file" >/dev/null 2>&1; then
      echo "✗ ${label} detected in ${file}" >&2
      grep -E -n -I --binary-files=without-match -- "$regex" "$file" 2>/dev/null | head -3 >&2
      FAIL=1
    fi
  done
done

if (( FAIL )); then
  echo "" >&2
  echo "Commit blocked: secrets detected in staged files." >&2
  echo "If this is a false positive (e.g. CI fixture, doc example), prefix the value" >&2
  echo "with 'EXAMPLE_' or move it to .env (gitignored)." >&2
  exit 1
fi

exit 0
