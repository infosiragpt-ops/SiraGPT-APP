#!/bin/bash
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
# Wait until Xvfb is accepting connections.
for _ in $(seq 1 40); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if [ -n "${COMPUTER_VNC_PASSWORD:-}" ]; then
  passfile=/tmp/x11vnc.pass
  x11vnc -storepasswd "$COMPUTER_VNC_PASSWORD" "$passfile"
  exec x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -rfbauth "$passfile"
fi

exec x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -nopw
