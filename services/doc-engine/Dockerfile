# SiraGPT OOXML document-engine sandbox
# Image tag: siragpt-sandbox:doc-engine
#
# Build:
#   docker build -t siragpt-sandbox:doc-engine -f services/doc-engine/Dockerfile .
#
# El runner endurecido (backend/src/services/doc-engine/runner.js) arranca
# contenedores efímeros con --network=none, rootfs read-only, --cap-drop=ALL,
# seccomp por defecto y uid 10001.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    LANG=C.UTF-8 \
    HOME=/workspace \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      poppler-utils \
      fonts-liberation \
      fonts-crosextra-carlito \
      zip \
      unzip \
      pandoc \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY services/doc-engine/requirements.lock /tmp/requirements.lock
RUN pip3 install --no-cache-dir -r /tmp/requirements.lock \
    && rm -f /tmp/requirements.lock

COPY packages/doc-skills /opt/doc-skills
COPY services/doc-engine/healthz.py /opt/doc-engine/healthz.py

RUN useradd -m -u 10001 -d /workspace sandbox \
    && mkdir -p /workspace /tmp \
    && chown -R 10001:10001 /workspace /opt/doc-skills /opt/doc-engine \
    && chmod 755 /opt/doc-engine/healthz.py \
    && find /opt/doc-skills -name '*.py' -exec chmod 755 {} +

USER 10001
WORKDIR /workspace

# Compose usa este CMD para healthz interno. El runner de jobs sobrescribe
# el comando con los scripts de /opt/doc-skills/scripts.
EXPOSE 8080
CMD ["python3", "/opt/doc-engine/healthz.py"]
