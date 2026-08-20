# SiraGPT per-session agent computer (Grok-bot style webtop).
#
# Deploy path on the VPS: /opt/siragpt/services/computer
# Build: docker build -t siragpt-computer:latest services/computer
#
# NOT the always-on CEO Office webtop (sira-dpc-*). This image is started
# one-container-per-session by services/computer/orchestrator and reaped
# after COMPUTER_TTL_MS (default 30 minutes).

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DISPLAY=:1 \
    HOME=/workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      supervisor \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      xfce4 \
      xfce4-terminal \
      thunar \
      dbus-x11 \
      xdotool \
      scrot \
      imagemagick \
      wget \
      gnupg \
      ca-certificates \
      x11-utils \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Node 20 for the in-image HTTP agent.
RUN wget -qO- https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome from the official repo (not Chromium).
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 10001 -d /workspace -s /bin/bash compuser \
    && mkdir -p \
      /workspace/.config \
      /workspace/.cache \
      /workspace/.chrome \
      /tmp/runtime-compuser \
      /var/log/supervisor \
      /opt/computer-agent \
    && chown -R compuser:compuser /workspace /tmp/runtime-compuser /opt/computer-agent

COPY start-x11vnc.sh start-chrome.sh /usr/local/bin/
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY agent/ /opt/computer-agent/

RUN chmod +x /usr/local/bin/start-x11vnc.sh /usr/local/bin/start-chrome.sh \
    && cd /opt/computer-agent && npm install --omit=dev \
    && chown -R compuser:compuser /opt/computer-agent

EXPOSE 5900 6080 8080 9222

# Supervisord stays root so it can launch Xvfb + drop xfce/chrome/agent to compuser.
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
