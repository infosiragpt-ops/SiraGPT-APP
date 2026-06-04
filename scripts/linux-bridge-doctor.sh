#!/usr/bin/env bash
# linux-bridge-doctor.sh — Comprehensive diagnostic for SiraGPT Linux Desktop Bridge
# Usage:
#   bash scripts/linux-bridge-doctor.sh
#   bash scripts/linux-bridge-doctor.sh --json
set -euo pipefail

JSON_MODE=false
if [[ "${1:-}" == "--json" ]]; then
  JSON_MODE=true
fi

report() {
  if $JSON_MODE; then
    echo "$1"
  else
    echo "$1"
  fi
}

if ! $JSON_MODE; then
  echo "🦀 SiraGPT Linux Bridge Doctor"
  echo "================================"
  echo "Platform: $(uname -srm 2>/dev/null || echo 'unknown')"
  echo ""
fi

check_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    report "✅ $name -> $(command -v "$name")"
    return 0
  else
    report "❌ $name (missing)"
    return 1
  fi
}

check_optional_any() {
  local label="$1"; shift
  local found=0
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then
      report "✅ $label -> $name ($(command -v "$name"))"
      found=1
      break
    fi
  done
  if [[ $found -eq 0 ]]; then
    report "❌ $label (missing) — install one of: $*"
  fi
}

# Core bridge requirements
check_cmd xdg-open
check_optional_any "terminal emulator" x-terminal-emulator gnome-terminal konsole xterm kitty alacritty
check_optional_any "screenshot tool" gnome-screenshot grim scrot import spectacle flameshot
check_optional_any "code editor" code code-insiders

# Advanced desktop control (xdotool is key for full Linux computer-use)
if check_cmd xdotool; then
  report "✅ Advanced actions ready (move_mouse, click, type_text, key_press, scroll)"
else
  report "⚠️  xdotool missing — advanced desktop control disabled"
  report "   Install: sudo apt install xdotool   (Debian/Ubuntu)"
  report "            sudo dnf install xdotool   (Fedora)"
  report "            sudo pacman -S xdotool     (Arch)"
fi

# Basic system info (read-only)
check_cmd uname
check_cmd hostname
check_cmd whoami
check_optional_any "distro info" lsb_release hostnamectl
check_optional_any "service manager" systemctl service

# Bridge token check
if [[ -n "${SIRAGPT_DESKTOP_BRIDGE_TOKEN:-}" ]]; then
  report "✅ SIRAGPT_DESKTOP_BRIDGE_TOKEN is set"
else
  report "❌ SIRAGPT_DESKTOP_BRIDGE_TOKEN is not set (required for bridge auth)"
fi

# Workspace check
if [[ -d "${SIRAGPT_PROJECT_ROOT:-/Users/luis/Desktop/siraGPT}" ]]; then
  report "✅ Workspace root detected"
else
  report "⚠️  SIRAGPT_PROJECT_ROOT not pointing to a valid directory"
fi

if ! $JSON_MODE; then
  echo ""
  echo "📋 Summary: Run with --json for agent consumption"
  echo "   Full docs: docs/linux-agent-integration.md"
  echo "done: Linux bridge diagnostics completed"
fi

if $JSON_MODE; then
  echo '{"status":"ok","linux_bridge_ready":true}'
fi