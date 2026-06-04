#!/usr/bin/env bash
set -euo pipefail

echo "SiraGPT Linux bridge doctor"
echo "platform: $(uname -srm 2>/dev/null || true)"

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "ok: $name -> $(command -v "$name")"
  else
    echo "missing: $name"
  fi
}

check_optional_any() {
  local label="$1"
  shift
  local found="0"
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then
      echo "ok: $label -> $name ($(command -v "$name"))"
      found="1"
      break
    fi
  done
  if [[ "$found" != "1" ]]; then
    echo "missing: $label -> install one of: $*"
  fi
}

check_cmd xdg-open
check_optional_any terminal x-terminal-emulator gnome-terminal konsole xterm
check_optional_any screenshot gnome-screenshot grim scrot import
check_optional_any code-editor code
check_cmd uname
check_cmd hostname
check_cmd whoami
check_optional_any distro-info lsb_release hostnamectl
check_optional_any service-status systemctl service

echo "done: read-only diagnostics completed"
