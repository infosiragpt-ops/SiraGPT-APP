# sira-desktop — F7.0 isolated X desktop + DCP.
#
# Build:
#   docker build -t sira-desktop:latest infra/desktop
#
# The container runs Xvfb :0, openbox, x11vnc, websockify/noVNC, xdotool,
# scrot, and the Desktop Control Plane on 127.0.0.1:9000.
# start.sh touches /workspace/.desktop_ready only after GET :9000/health is 200.
#
# User `sira` is created BY NAME. Do NOT force -u 1000 — node/debian images
# may already own that uid (see PR #485).
#
# This image does NOT replace services/computer-orchestrator (live orch, #484).

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    LANG=C.UTF-8 \
    HOME=/home/sira

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      openbox \
      x11vnc \
      novnc \
      websockify \
      xdotool \
      scrot \
      python3 \
      ca-certificates \
      fonts-dejavu-core \
      procps \
    && rm -rf /var/lib/apt/lists/* \
    && (getent passwd sira >/dev/null || useradd -m -s /bin/bash sira) \
    && mkdir -p /workspace /opt/sira-dcp \
    && chown sira:sira /workspace

COPY dcp/dcp.py /opt/sira-dcp/dcp.py
COPY start.sh /usr/local/bin/start.sh
RUN chmod 755 /usr/local/bin/start.sh /opt/sira-dcp/dcp.py

WORKDIR /workspace
# DCP is 127.0.0.1:9000 (not published). noVNC/VNC stay on loopback in F7.0.
CMD ["/usr/local/bin/start.sh"]
