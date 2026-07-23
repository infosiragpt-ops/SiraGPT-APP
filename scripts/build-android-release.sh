#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
KEYSTORE_PROPS="$ANDROID_DIR/keystore.properties"
OUTPUT_DIR="$ROOT_DIR/output"
OUTPUT_AAB="$OUTPUT_DIR/SiraGPT-android-release.aab"
OUTPUT_APK="$OUTPUT_DIR/SiraGPT-android-release.apk"

if [ ! -f "$KEYSTORE_PROPS" ]; then
  cat >&2 <<'MSG'
Missing android/keystore.properties.

Create the Play Store upload key first:
  1. Copy android/keystore.properties.example to android/keystore.properties.
  2. Generate android/keystores/siragpt-upload-key.jks.
  3. Fill storePassword and keyPassword in android/keystore.properties.

This file is intentionally ignored by Git because it contains signing secrets.
MSG
  exit 1
fi

if [ -z "${JAVA_HOME:-}" ] && [ -d "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" ]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi

if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

if [ -z "${ANDROID_SDK_ROOT:-}" ] && [ -n "${ANDROID_HOME:-}" ]; then
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
fi

mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR"
npm run mobile:sync

cd "$ANDROID_DIR"
./gradlew bundleRelease assembleRelease

cp "$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab" "$OUTPUT_AAB"
cp "$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk" "$OUTPUT_APK"
ls -lh "$OUTPUT_AAB" "$OUTPUT_APK"
