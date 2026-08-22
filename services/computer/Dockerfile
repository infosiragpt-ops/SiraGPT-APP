FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 DISPLAY=:1 HOME=/workspace USER=compuser
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg apt-transport-https \
        supervisor xvfb x11vnc novnc websockify \
        xfce4 xfce4-terminal thunar dbus-x11 \
        x11-utils x11-xserver-utils procps python3 \
        fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends xdotool scrot imagemagick && rm -rf /var/lib/apt/lists/*

# google-chrome-stable from Google apt repo
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-linux.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Node 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

RUN useradd -m -d /workspace -s /bin/bash -u 1000 compuser && mkdir -p /workspace/Downloads /workspace/.chrome /workspace/.config /var/run/dbus /var/log/supervisor /opt/agent /tmp/runtime-compuser && dbus-uuidgen > /etc/machine-id && chown -R compuser:compuser /workspace /opt/agent /tmp/runtime-compuser
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY supervisord.conf /etc/supervisor/conf.d/computer.conf
COPY xfce/ /opt/xfce-skel/
COPY agent/package.json /opt/agent/package.json
COPY agent/ /opt/agent/
RUN cd /opt/agent && npm i --omit=dev
EXPOSE 8080
EXPOSE 6080 5900 9222
HEALTHCHECK --interval=20s --timeout=5s --retries=10 CMD curl -fsS http://127.0.0.1:8080/health || exit 1
RUN chmod 755 /workspace && chown -R compuser:compuser /workspace /opt/agent /var/log/supervisor /tmp/runtime-compuser && chmod 777 /var/log/supervisor /run
USER compuser
CMD ["/bin/bash", "/entrypoint.sh"]
