FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0

WORKDIR /opt/sira-controller
COPY --chown=0:0 runsc-sandbox-controller.js ./runsc-sandbox-controller.js
COPY --chown=0:0 runsc-sandbox-service.js ./runsc-sandbox-service.js
COPY --chown=0:0 runsc-sandbox-docker-api.js ./runsc-sandbox-docker-api.js
COPY --chown=0:0 runsc-sandbox-controller-utils.js ./runsc-sandbox-controller-utils.js
COPY --chown=0:0 runsc-sandbox-activity-store.js ./runsc-sandbox-activity-store.js
RUN chmod 0555 ./*.js \
    && mkdir -p /var/lib/sira-runsc-controller \
    && chown 65532:65532 /var/lib/sira-runsc-controller \
    && chmod 0700 /var/lib/sira-runsc-controller

LABEL org.opencontainers.image.title="SiraGPT runsc sandbox controller" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT"

USER 65532:65532
ENTRYPOINT ["node", "/opt/sira-controller/runsc-sandbox-controller.js"]
