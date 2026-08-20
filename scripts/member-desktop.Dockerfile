FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    LANG=C.UTF-8 \
    HOME=/home/agent \
    USER=agent

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        dbus-x11 \
        fonts-liberation \
        novnc \
        procps \
        python3 \
        sudo \
        thunar \
        websockify \
        x11vnc \
        xfce4 \
        xfce4-session \
        xfce4-terminal \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash agent \
    && mkdir -p /workspace/inspect /workspace/ship /home/agent \
    && chown -R agent:agent /home/agent /workspace

COPY member-desktop-start.sh /usr/local/bin/member-desktop-start.sh
RUN chmod 0755 /usr/local/bin/member-desktop-start.sh

USER agent
WORKDIR /workspace
EXPOSE 6080
CMD ["/usr/local/bin/member-desktop-start.sh"]
