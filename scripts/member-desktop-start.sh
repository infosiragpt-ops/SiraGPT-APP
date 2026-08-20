#!/bin/bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/agent}"
mkdir -p "$HOME" /workspace/inspect /workspace/ship
chmod 0755 /workspace /workspace/inspect /workspace/ship || true

Xvfb "$DISPLAY" -screen 0 "${SIRAGPT_DESKTOP_GEOMETRY:-1280x800x24}" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
sleep 0.6

dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &
sleep 0.8

# Loopback-only VNC: the authenticated SiraGPT proxy is the only ingress.
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

NOVNC_WEB="${NOVNC_WEB:-/usr/share/novnc}"
if [[ ! -d "$NOVNC_WEB" ]]; then
  NOVNC_WEB="/usr/share/novnc/utils/.."
fi

exec websockify --web="$NOVNC_WEB" 0.0.0.0:6080 127.0.0.1:5900
