FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS node-runtime
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

COPY --from=node-runtime /usr/local/ /usr/local/
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace /home/sandbox /cache /opt/sira-sandbox \
  && touch /workspace/.sira-volume-owner \
  && chown -R 10001:10001 /workspace /home/sandbox /cache \
  && chmod 0700 /workspace /home/sandbox /cache

COPY --chown=0:0 runsc-sandbox-idle-worker.js /opt/sira-sandbox/idle-worker.js
RUN chmod 0555 /opt/sira-sandbox/idle-worker.js

LABEL org.opencontainers.image.title="SiraGPT runsc sandbox worker" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="Apache-2.0 AND MIT"

WORKDIR /workspace
USER 10001:10001
ENTRYPOINT []
CMD ["node", "/opt/sira-sandbox/idle-worker.js"]
