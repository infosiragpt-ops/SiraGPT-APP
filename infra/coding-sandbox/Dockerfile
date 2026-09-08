# DEV session image for AGENTES_CODING_V2 (Phase 2a).
# Non-root, no Docker CLI, no secrets. Apache/MIT base (official Node).
# Optional later: MIT ast-grep `sg` binary for Phase 3c structural edit.
# Not installed here — no monorepo dump. The Node wrapper is injectable.
FROM node:20-bookworm-slim

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin sandbox \
  && mkdir -p /workspace \
  && chown 10001:10001 /workspace

WORKDIR /workspace
USER 10001
CMD ["sleep", "infinity"]
