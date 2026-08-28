FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    LANG=C.UTF-8

# Desktop + VNC + noVNC + Chrome CDP + xdotool. Same image is the
# orchestrator (CMD node) and each sira-ac-user-* clone (start-desktop.sh).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      xfce4 \
      xfce4-terminal \
      thunar \
      dbus-x11 \
      chromium \
      xdotool \
      imagemagick \
      novnc \
      websockify \
      python3 \
      ca-certificates \
      fonts-liberation \
      fonts-dejavu-core \
      procps \
    && rm -rf /var/lib/apt/lists/* \
    && CHROME_BIN="$(command -v chromium || command -v chromium-browser || true)" \
    && if [ -n "$CHROME_BIN" ]; then ln -sf "$CHROME_BIN" /usr/local/bin/google-chrome; fi \
    && (getent passwd compuser >/dev/null || useradd -m -s /bin/bash compuser) \
    && mkdir -p /workspace /opt/sira-orch \
    && chown compuser:compuser /workspace

COPY session-store.js docker-runtime.js agent-actions.js http-proxy.js server.js /opt/sira-orch/
COPY start-desktop.sh /usr/local/bin/start-desktop.sh
RUN chmod 755 /usr/local/bin/start-desktop.sh

WORKDIR /opt/sira-orch
EXPOSE 8090
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/opt/sira-orch/server.js"]
