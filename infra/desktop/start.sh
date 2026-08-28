#!/bin/bash
# sira-desktop entrypoint (F7.0).
# Xvfb :0 + openbox + x11vnc + websockify/noVNC + xdotool + scrot + DCP :9000
# Touches /workspace/.desktop_ready ONLY after DCP /health is 200.
set -u
export DISPLAY="${DISPLAY:-:0}"
export HOME="${HOME:-/home/sira}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-sira}"
READY_FILE="${DESKTOP_READY_FILE:-/workspace/.desktop_ready}"
DCP_URL="${SIRA_DCP_URL:-http://127.0.0.1:9000/health}"

rm -f "$READY_FILE"

mkdir -p /tmp/.X11-unix /workspace "$HOME" "$XDG_RUNTIME_DIR"
chmod 1777 /tmp/.X11-unix
chown -R sira:sira /workspace "$HOME" "$XDG_RUNTIME_DIR" || true

rm -f /tmp/.X0-lock /tmp/.X11-unix/X0
Xvfb :0 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
sleep 0.4

# Wait until the X socket exists (no extra x11-utils dependency).
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ -e /tmp/.X11-unix/X0 ]; then
    break
  fi
  sleep 0.2
done

x11vnc -display :0 -forever -shared -rfbport 5900 -nopw -listen 127.0.0.1 -xkb -ncache 0 &

run_as_sira() {
  su -s /bin/bash sira -c "export DISPLAY=:0 HOME=$HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR; $*"
}

run_as_sira "openbox" &
sleep 0.3

NOVNC_WEB=""
for candidate in /usr/share/novnc /usr/share/novnc/www; do
  if [ -f "$candidate/vnc.html" ]; then
    NOVNC_WEB="$candidate"
    break
  fi
done
if [ -z "$NOVNC_WEB" ]; then
  NOVNC_WEB="/usr/share/novnc"
fi

# noVNC stays on loopback in F7.0 (WS proxy is a later phase).
websockify --web="$NOVNC_WEB" 127.0.0.1:6080 127.0.0.1:5900 &

run_as_sira "python3 /opt/sira-dcp/dcp.py" &

ok=0
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if python3 -c "import urllib.request; urllib.request.urlopen('$DCP_URL', timeout=2).read()" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.3
done

if [ "$ok" = "1" ]; then
  touch "$READY_FILE"
  chown sira:sira "$READY_FILE" || true
else
  echo "sira-desktop: DCP $DCP_URL never became healthy — not writing $READY_FILE" >&2
fi

# Keep the container alive even if one child exits.
while true; do
  sleep 30
done
