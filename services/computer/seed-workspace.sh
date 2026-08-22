#!/bin/sh
# Seed XFCE/Chrome home dirs when the persistent /workspace volume is empty.
# Does not overwrite files the member already has.
set -eu

SKEL="${COMPUTER_WORKSPACE_SKEL:-/opt/compuser-skel}"
ROOT="${COMPUTER_WORKSPACE_ROOT:-/workspace}"

mkdir -p "$ROOT"
if [ -d "$SKEL" ] && [ ! -d "$ROOT/.config" ]; then
  cp -a "$SKEL"/. "$ROOT"/ || true
fi
mkdir -p "$ROOT/.config" "$ROOT/.cache" "$ROOT/.chrome"
chown -R compuser:compuser "$ROOT" 2>/dev/null || true
exit 0
