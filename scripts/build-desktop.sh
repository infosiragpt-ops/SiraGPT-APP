#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TARGET="${1:-dir}"

cd "$ROOT_DIR"

case "$TARGET" in
  dir)
    npx electron-builder --projectDir apps/desktop --dir --publish never
    ;;
  mac)
    npx electron-builder --projectDir apps/desktop --mac dmg zip --arm64 --x64 --publish never
    ;;
  mac-dir)
    npx electron-builder --projectDir apps/desktop --mac dir --publish never
    ;;
  win)
    npx electron-builder --projectDir apps/desktop --win nsis portable --x64 --publish never
    ;;
  win-dir)
    npx electron-builder --projectDir apps/desktop --win dir --x64 --publish never
    ;;
  *)
    cat >&2 <<'MSG'
Usage: scripts/build-desktop.sh [dir|mac|mac-dir|win|win-dir]
MSG
    exit 1
    ;;
esac
