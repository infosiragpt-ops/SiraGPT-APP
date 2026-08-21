#!/bin/bash
mkdir -p /workspace/Downloads /workspace/.chrome /workspace/.config /tmp/runtime-compuser || true
if [ ! -d /workspace/.config/xfce4 ]; then
  mkdir -p /workspace/.config || true
  cp -a /opt/xfce-skel/. /workspace/.config/ || true
fi
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/computer.conf
