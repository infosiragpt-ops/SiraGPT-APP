#!/usr/bin/env bash
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-infosiragpt-ops/SiraGPT-APP}"
PLATFORM="all"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-native-github-secrets.sh [--repo=owner/name] [--platform=all|mobile|desktop|apple|android|ios|macos|windows] [--dry-run]

Uploads native app signing secrets to GitHub Actions without printing secret
values. File-based credentials are base64-encoded locally before upload.

Direct-value environment variables:
  ANDROID_KEYSTORE_PASSWORD
  ANDROID_KEY_ALIAS
  ANDROID_KEY_PASSWORD
  APPLE_TEAM_ID
  IOS_SIGNING_CERTIFICATE_PASSWORD
  APP_STORE_CONNECT_API_KEY_ID
  APP_STORE_CONNECT_API_ISSUER_ID
  MACOS_CERTIFICATE_PASSWORD
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  WINDOWS_CERTIFICATE_PASSWORD

File path environment variables:
  ANDROID_KEYSTORE_PATH
  IOS_SIGNING_CERTIFICATE_PATH
  IOS_PROVISIONING_PROFILE_PATH
  APP_STORE_CONNECT_API_KEY_PATH
  MACOS_CERTIFICATE_PATH
  WINDOWS_CERTIFICATE_PATH

Already-base64 environment variables are also accepted:
  ANDROID_KEYSTORE_BASE64
  IOS_SIGNING_CERTIFICATE_BASE64
  IOS_PROVISIONING_PROFILE_BASE64
  APP_STORE_CONNECT_API_KEY_BASE64
  MACOS_CERTIFICATE_BASE64
  WINDOWS_CERTIFICATE_BASE64

Examples:
  ANDROID_KEYSTORE_PATH=/secure/siragpt-upload-key.jks \
  ANDROID_KEYSTORE_PASSWORD=... \
  ANDROID_KEY_ALIAS=siragpt \
  ANDROID_KEY_PASSWORD=... \
  bash scripts/setup-native-github-secrets.sh --platform=android

  bash scripts/setup-native-github-secrets.sh --platform=all --dry-run
EOF
}

for arg in "$@"; do
  case "$arg" in
    --repo=*)
      REPO="${arg#--repo=}"
      ;;
    --platform=*)
      PLATFORM="${arg#--platform=}"
      ;;
    --dry-run)
      DRY_RUN=1
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

GROUPS_TO_SET=()

append_group() {
  local group="$1"
  local existing
  if [ "${#GROUPS_TO_SET[@]}" -gt 0 ]; then
    for existing in "${GROUPS_TO_SET[@]}"; do
      if [ "$existing" = "$group" ]; then
        return
      fi
    done
  fi
  GROUPS_TO_SET+=("$group")
}

expand_platform() {
  case "$1" in
    all)
      append_group android
      append_group ios
      append_group appstore
      append_group macos
      append_group windows
      ;;
    mobile)
      append_group android
      append_group ios
      append_group appstore
      ;;
    desktop)
      append_group macos
      append_group windows
      ;;
    apple)
      append_group ios
      append_group appstore
      append_group macos
      ;;
    android|ios|appstore|macos|windows)
      append_group "$1"
      if [ "$1" = "ios" ]; then
        append_group appstore
      fi
      ;;
    *)
      echo "Unknown platform: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
}

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
      echo "Unknown secret group: $1" >&2
      exit 2
      ;;
  esac
}

base64_file() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    return 1
  fi
  base64 < "$file_path" | tr -d '\n'
}

secret_file_env() {
  case "$1" in
    ANDROID_KEYSTORE_BASE64)
      echo "ANDROID_KEYSTORE_PATH"
      ;;
    IOS_SIGNING_CERTIFICATE_BASE64)
      echo "IOS_SIGNING_CERTIFICATE_PATH"
      ;;
    IOS_PROVISIONING_PROFILE_BASE64)
      echo "IOS_PROVISIONING_PROFILE_PATH"
      ;;
    APP_STORE_CONNECT_API_KEY_BASE64)
      echo "APP_STORE_CONNECT_API_KEY_PATH"
      ;;
    MACOS_CERTIFICATE_BASE64)
      echo "MACOS_CERTIFICATE_PATH"
      ;;
    WINDOWS_CERTIFICATE_BASE64)
      echo "WINDOWS_CERTIFICATE_PATH"
      ;;
    *)
      echo ""
      ;;
  esac
}

secret_value() {
  local secret_name="$1"
  local file_env
  local file_path

  if [ -n "${!secret_name:-}" ]; then
    printf '%s' "${!secret_name}"
    return 0
  fi

  file_env="$(secret_file_env "$secret_name")"
  if [ -n "$file_env" ] && [ -n "${!file_env:-}" ]; then
    file_path="${!file_env}"
    base64_file "$file_path"
    return $?
  fi

  return 1
}

source_hint() {
  local secret_name="$1"
  local file_env

  if [ -n "${!secret_name:-}" ]; then
    echo "$secret_name"
    return
  fi

  file_env="$(secret_file_env "$secret_name")"
  if [ -n "$file_env" ] && [ -n "${!file_env:-}" ]; then
    echo "$file_env"
    return
  fi

  file_env="$(secret_file_env "$secret_name")"
  if [ -n "$file_env" ]; then
    echo "$secret_name or $file_env"
  else
    echo "$secret_name"
  fi
}

append_secret() {
  local secret_name="$1"
  local existing
  if [ "${#SECRETS_TO_SET[@]}" -gt 0 ]; then
    for existing in "${SECRETS_TO_SET[@]}"; do
      if [ "$existing" = "$secret_name" ]; then
        return
      fi
    done
  fi
  SECRETS_TO_SET+=("$secret_name")
}

expand_platform "$PLATFORM"

SECRETS_TO_SET=()
for group in "${GROUPS_TO_SET[@]}"; do
  for secret_name in $(group_secrets "$group"); do
    append_secret "$secret_name"
  done
done

if [ "$DRY_RUN" -eq 0 ]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "GitHub CLI is required: install and authenticate gh first." >&2
    exit 2
  fi
  gh auth status >/dev/null
fi

missing=0
ready=0
uploaded=0

echo "Repository: $REPO"
echo "Platform: $PLATFORM"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Mode: dry-run"
else
  echo "Mode: upload"
fi

for secret_name in "${SECRETS_TO_SET[@]}"; do
  if value="$(secret_value "$secret_name")"; then
    ready=$((ready + 1))
    if [ "$DRY_RUN" -eq 1 ]; then
      printf 'ready: %s from %s\n' "$secret_name" "$(source_hint "$secret_name")"
    else
      printf '%s' "$value" | gh secret set "$secret_name" --repo "$REPO" >/dev/null
      printf 'uploaded: %s\n' "$secret_name"
      uploaded=$((uploaded + 1))
    fi
  else
    missing=$((missing + 1))
    printf 'missing input: %s (set %s)\n' "$secret_name" "$(source_hint "$secret_name")"
  fi
done

echo "Summary: ready=$ready uploaded=$uploaded missing_input=$missing"

if [ "$missing" -gt 0 ]; then
  exit 1
fi
