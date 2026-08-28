#!/bin/bash
# Persistent isolated desktop for one member+conversation.
# User: compuser · DISPLAY=:1 · VNC :5901 · noVNC :6080 · Chrome CDP :9222
set -u
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/compuser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-compuser}"

mkdir -p /tmp/.X11-unix /workspace/.chrome "$HOME" "$XDG_RUNTIME_DIR" /var/run/dbus
chmod 1777 /tmp/.X11-unix
chown -R compuser:compuser /workspace "$HOME" "$XDG_RUNTIME_DIR" || true

if [ ! -e /var/run/dbus/system_bus_socket ]; then
  dbus-daemon --system --fork || true
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
sleep 0.4

x11vnc -display :1 -forever -shared -rfbport 5901 -nopw -listen 0.0.0.0 -xkb -ncache 0 &

run_as_compuser() {
  su -s /bin/bash compuser -c "export DISPLAY=:1 HOME=$HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR; $*"
}

run_as_compuser "dbus-launch --exit-with-session startxfce4" &
sleep 0.8

CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -n "$CHROME_BIN" ]; then
  run_as_compuser "$CHROME_BIN --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --disable-session-crashed-bubble --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir=/workspace/.chrome about:blank" &
fi

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

websockify --web="$NOVNC_WEB" 6080 127.0.0.1:5901 &

# Keep the container alive even if one child exits.
while true; do
  sleep 30
done
