# DEV session image for AGENTES_CODING_V2 (Phase 2a).
# Non-root, no Docker CLI, no secrets. Apache/MIT base (official Node).
FROM node:20-bookworm-slim

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox \
  && mkdir -p /workspace \
  && chown 10001:10001 /workspace

WORKDIR /workspace
USER 10001
CMD ["sleep", "infinity"]
