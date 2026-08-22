#!/bin/bash
set +e
export DISPLAY="${DISPLAY:-:1}"
export HOME=/config
export XDG_CONFIG_HOME=/config/.config
if [ "$(id -u)" = 0 ]; then
  if ! command -v plank >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends plank >/tmp/sira-plank-apt.log 2>&1
  fi
  mkdir -p /config/.config/plank/dock1/launchers /config/.config/autostart
  cat > /config/.config/plank/dock1/settings <<'EOF'
[PlankDockPreferences]
Alignment=3
AutoPinning=false
CurrentWorkspaceOnly=false
DockItems=chromium.dockitem;;thunar.dockitem;;xfce4-terminal.dockitem
HideMode=0
IconSize=42
ItemsAlignment=3
LockItems=true
Monitor=
Offset=0
PinnedOnly=true
Position=3
PressureReveal=false
ShowDockItem=false
Theme=Default
TooltipsEnabled=true
UnhideDelay=0
ZoomEnabled=true
ZoomPercent=140
EOF
  cat > /config/.config/plank/dock1/launchers/chromium.dockitem <<'EOF'
[PlankDockItemPreferences]
Launcher=file:///usr/share/applications/chromium.desktop
EOF
  cat > /config/.config/plank/dock1/launchers/thunar.dockitem <<'EOF'
[PlankDockItemPreferences]
Launcher=file:///usr/share/applications/thunar.desktop
EOF
  cat > /config/.config/plank/dock1/launchers/xfce4-terminal.dockitem <<'EOF'
[PlankDockItemPreferences]
Launcher=file:///usr/share/applications/xfce4-terminal.desktop
EOF
  cat > /config/.config/autostart/plank.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Plank
Exec=plank
OnlyShowIn=XFCE;
X-XFCE-Autostart-Override=true
EOF
  chown -R abc:abc /config/.config/plank /config/.config/autostart 2>/dev/null
  find /config/.config/plank/dock1/launchers -type f ! -name 'chromium.dockitem' ! -name 'thunar.dockitem' ! -name 'xfce4-terminal.dockitem' -delete 2>/dev/null
  touch /config/sira-grok-layout.ok
  if command -v su >/dev/null 2>&1; then
    exec su -s /bin/bash abc -c 'DISPLAY=:1 HOME=/config XDG_CONFIG_HOME=/config/.config bash /config/sira-grok-layout.sh --as-user'
  fi
fi
xfconf-query -c xfce4-panel -p /panels/panel-1/autohide-behavior -n -t int -s 2 >/dev/null 2>&1
xfconf-query -c xfce4-panel -p /panels/panel-1/size -n -t uint -s 2 >/dev/null 2>&1
xfconf-query -c xfce4-panel -p /panels/panel-1/icon-size -n -t uint -s 12 >/dev/null 2>&1
if command -v plank >/dev/null 2>&1; then
  if ! pgrep -x plank >/dev/null 2>&1; then
    nohup plank >>/config/sira-plank.log 2>&1 &
    echo $! > /config/sira-plank.pid
    sleep 0.8
  fi
  echo PLANK_UP
else
  echo PLANK_MISSING
fi
if command -v python3 >/dev/null 2>&1 && [ -x /config/sira-deskctl.py ]; then
  python3 /config/sira-deskctl.py unmax >/dev/null 2>&1
fi
if ! pgrep -x xfce4-terminal >/dev/null 2>&1; then
  nohup xfce4-terminal --disable-server --geometry=72x16+40+430 --working-directory=/config --title=Terminal >>/config/sira-term.log 2>&1 &
  echo $! > /config/sira-term.pid
fi
if ! pgrep -f 'thunar-real /' >/dev/null 2>&1; then
  nohup thunar /config >>/config/sira-thunar.log 2>&1 &
  echo $! > /config/sira-thunar.pid
fi
echo GROK_LAYOUT_OK
exit 0
