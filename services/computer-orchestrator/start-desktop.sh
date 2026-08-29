#!/bin/bash
# Persistent isolated desktop for one member+conversation.
# User: compuser · DISPLAY=:1 · VNC :5901 · noVNC :6080 · Chrome CDP :9222
# Look: Grok Bot — gray fabric wallpaper, no xfce panel, Plank with
# Chrome + Thunar + Terminal. Existing containers keep the old look
# until they are recreated.
set -u
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/compuser}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-compuser}"

LOOK_DIR="/opt/sira-orch/desktop-look"
WALLPAPER="/usr/share/backgrounds/sira-gray-fabric.jpg"

mkdir -p /tmp/.X11-unix /workspace/.chrome "$HOME" "$XDG_RUNTIME_DIR" /var/run/dbus
chmod 1777 /tmp/.X11-unix
chown -R compuser:compuser /workspace "$HOME" "$XDG_RUNTIME_DIR" || true

if [ ! -e /var/run/dbus/system_bus_socket ]; then
  dbus-daemon --system --fork || true
fi

install_desktop_look() {
  mkdir -p \
    "$HOME/.config/autostart" \
    "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml" \
    "$HOME/.config/plank/dock1/launchers"
  if [ -f "$LOOK_DIR/xfce/xfce4-panel.desktop" ]; then
    cp -f "$LOOK_DIR/xfce/xfce4-panel.desktop" "$HOME/.config/autostart/xfce4-panel.desktop"
  fi
  if [ -f "$LOOK_DIR/xfce/xfce4-desktop.xml" ]; then
    cp -f "$LOOK_DIR/xfce/xfce4-desktop.xml" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml"
  fi
  if [ -f "$LOOK_DIR/xfce/xfce4-panel.xml" ]; then
    cp -f "$LOOK_DIR/xfce/xfce4-panel.xml" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
  fi
  if [ -f "$LOOK_DIR/plank/settings" ]; then
    cp -f "$LOOK_DIR/plank/settings" "$HOME/.config/plank/dock1/settings"
  fi
  if [ -d "$LOOK_DIR/plank/launchers" ]; then
    cp -f "$LOOK_DIR/plank/launchers/"*.dockitem "$HOME/.config/plank/dock1/launchers/" 2>/dev/null || true
  fi
  chown -R compuser:compuser "$HOME/.config" || true
}

apply_wallpaper() {
  [ -f "$WALLPAPER" ] || return 0
  for prop in \
    /backdrop/screen0/monitor0/workspace0/last-image \
    /backdrop/screen0/monitorVirtual1/workspace0/last-image \
    /backdrop/screen0/monitorXVFB-0/workspace0/last-image \
    /backdrop/screen0/monitor0/image-path
  do
    run_as_compuser "xfconf-query -c xfce4-desktop -p $prop -n -t string -s $WALLPAPER" || true
  done
}

hide_xfce_panel() {
  run_as_compuser "pkill -x xfce4-panel" || true
}

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
Xvfb :1 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
sleep 0.4

x11vnc -display :1 -forever -shared -rfbport 5901 -nopw -listen 0.0.0.0 -xkb -ncache 0 &

run_as_compuser() {
  su -s /bin/bash compuser -c "export DISPLAY=:1 HOME=$HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR; $*"
}

install_desktop_look

run_as_compuser "dbus-launch --exit-with-session startxfce4" &
sleep 0.8
hide_xfce_panel
apply_wallpaper
run_as_compuser "plank" &
sleep 0.3
hide_xfce_panel

CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -n "$CHROME_BIN" ]; then
  # CDP on 9222 without a visible window. Dock / agent actions open Chrome later.
  run_as_compuser "$CHROME_BIN --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --disable-session-crashed-bubble --no-startup-window --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir=/workspace/.chrome" &
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
