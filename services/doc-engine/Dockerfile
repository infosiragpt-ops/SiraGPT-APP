# SiraGPT OOXML document-engine sandbox
# Image tags: siragpt-sandbox:doc-engine  AND  iliagpt-sandbox:doc-engine
#
# Build:
#   docker build -t siragpt-sandbox:doc-engine -t iliagpt-sandbox:doc-engine \
#     -f services/doc-engine/Dockerfile .
#
# El runner endurecido arranca contenedores efímeros:
#   docker run --rm --network=none --read-only --cap-drop=ALL
#     --security-opt=no-new-privileges --user=10001:10001
#     --tmpfs /workspace:rw,nosuid,nodev,noexec,size=536870912
#     --pids-limit=256 --memory=768m --cpus=1
#     siragpt-sandbox:doc-engine

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/workspace \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 \
      python3.11-venv \
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
    && python3.11 -m venv /opt/venv \
    && rm -rf /var/lib/apt/lists/*

COPY services/doc-engine/requirements.lock /tmp/requirements.lock
RUN /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
    && rm -f /tmp/requirements.lock

COPY packages/doc-skills /opt/doc-skills
COPY services/doc-engine/healthz.py /opt/doc-engine/healthz.py

RUN useradd -m -u 10001 -d /workspace sandbox \
    && mkdir -p /workspace /tmp \
    && chown -R 10001:10001 /workspace /opt/doc-skills /opt/doc-engine /opt/venv \
    && chmod 755 /opt/doc-engine/healthz.py \
    && find /opt/doc-skills -name '*.py' -exec chmod 755 {} +

USER 10001
WORKDIR /workspace

# Compose usa este CMD para healthz interno (EXPOSE only, no host ports).
# El runner de jobs sobrescribe el comando con /opt/doc-skills/scripts/*.
EXPOSE 8080
CMD ["python3", "/opt/doc-engine/healthz.py"]
