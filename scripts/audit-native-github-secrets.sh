#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-infosiragpt-ops/SiraGPT-APP}"
REQUIRE=""
ONLY_REQUIRED=0

usage() {
  cat <<'EOF'
Usage: bash scripts/audit-native-github-secrets.sh [--repo=owner/name] [--require=group[,group...]] [--only-required]

Audits GitHub Actions secret names required for native app signing.
It prints only secret names and readiness states; it never reads or prints secret values.

Groups:
  android   Android Play upload key secrets
  ios       iOS certificate and provisioning profile secrets
  appstore  App Store Connect API upload secrets
  macos     macOS Developer ID/notarization secrets
  windows   Windows code-signing secrets
  mobile    android, ios
  desktop   macos, windows
  apple     ios, appstore, macos
  all       android, ios, appstore, macos, windows
EOF
}

for arg in "$@"; do
  case "$arg" in
    --repo=*)
      REPO="${arg#--repo=}"
      ;;
    --require=*)
      REQUIRE="${arg#--require=}"
      ;;
    --only-required)
      ONLY_REQUIRED=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: install and authenticate gh first." >&2
  exit 2
fi

group_secrets() {
  case "$1" in
    android)
      echo "ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD"
      ;;
    ios)
      echo "APPLE_TEAM_ID IOS_SIGNING_CERTIFICATE_BASE64 IOS_SIGNING_CERTIFICATE_PASSWORD IOS_PROVISIONING_PROFILE_BASE64"
      ;;
    appstore)
      echo "APP_STORE_CONNECT_API_KEY_ID APP_STORE_CONNECT_API_ISSUER_ID APP_STORE_CONNECT_API_KEY_BASE64"
      ;;
    macos)
      echo "MACOS_CERTIFICATE_BASE64 MACOS_CERTIFICATE_PASSWORD APPLE_TEAM_ID APPLE_ID APPLE_APP_SPECIFIC_PASSWORD"
      ;;
    windows)
      echo "WINDOWS_CERTIFICATE_BASE64 WINDOWS_CERTIFICATE_PASSWORD"
      ;;
    *)
      echo "Unknown release group: $1" >&2
      exit 2
      ;;
  esac
}

append_group() {
  local group="$1"
  local existing
  if [ "${#GROUPS_TO_CHECK[@]}" -gt 0 ]; then
    for existing in "${GROUPS_TO_CHECK[@]}"; do
      if [ "$existing" = "$group" ]; then
        return
      fi
    done
  fi
  GROUPS_TO_CHECK+=("$group")
}

expand_group() {
  case "$1" in
    all)
      append_group android
      append_group ios
      append_group appstore
      append_group macos
      append_group windows
      ;;
    apple)
      append_group ios
      append_group appstore
      append_group macos
      ;;
    desktop)
      append_group macos
      append_group windows
      ;;
    mobile)
      append_group android
      append_group ios
      ;;
    android|ios|appstore|macos|windows)
      append_group "$1"
      ;;
    "")
      ;;
    *)
      echo "Unknown release group: $1" >&2
      exit 2
      ;;
  esac
}

GROUPS_TO_CHECK=()
if [ -n "$REQUIRE" ]; then
  IFS=',' read -r -a REQUIRED_GROUPS <<< "$REQUIRE"
  for group in "${REQUIRED_GROUPS[@]}"; do
    expand_group "${group//[[:space:]]/}"
  done
elif [ "$ONLY_REQUIRED" -eq 0 ]; then
  expand_group all
fi

if [ "${#GROUPS_TO_CHECK[@]}" -eq 0 ]; then
  echo "No groups selected." >&2
  usage >&2
  exit 2
fi

PRESENT_SECRETS=()
while IFS= read -r secret_name; do
  if [ -n "$secret_name" ]; then
    PRESENT_SECRETS+=("$secret_name")
  fi
done < <(gh secret list --repo "$REPO" | awk '{print $1}')

has_secret() {
  local needle="$1"
  local present
  for present in "${PRESENT_SECRETS[@]}"; do
    if [ "$present" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

failed_groups=()

echo "Repository: $REPO"
for group in "${GROUPS_TO_CHECK[@]}"; do
  missing=()
  for secret_name in $(group_secrets "$group"); do
    if ! has_secret "$secret_name"; then
      missing+=("$secret_name")
    fi
  done

  if [ "${#missing[@]}" -eq 0 ]; then
    echo "$group: ready"
  else
    echo "$group: missing"
    printf '  missing: %s\n' "${missing[*]}"
    failed_groups+=("$group")
  fi
done

if [ -n "$REQUIRE" ] && [ "${#failed_groups[@]}" -gt 0 ]; then
  printf 'Required GitHub secret groups are incomplete: %s\n' "${failed_groups[*]}" >&2
  exit 1
fi
