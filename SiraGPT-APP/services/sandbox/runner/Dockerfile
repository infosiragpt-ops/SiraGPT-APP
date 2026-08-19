# SiraGPT document-agent sandbox image.
#
# One EPHEMERAL container per document task (started by
# backend/src/services/doc-agent/sandbox.js with: --network none,
# --memory 1g, --cpus 1, auto-remove). The agent gets bash/read/write/
# str_replace/list tools bound to /workspace; uploads are mounted under
# /workspace/uploads and deliverables must be written to /workspace/outputs.
#
# Build (on the Docker host / VPS):
#   docker build -t siragpt-doc-sandbox:latest infra/sandbox
#
# Override the image name via SIRAGPT_DOC_SANDBOX_IMAGE.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    HOME=/workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk \
      zip unzip \
      python3 python3-pip \
      libreoffice --no-install-recommends \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Document-manipulation libraries the skills prompt teaches the model to use.
# pandas + numpy power the CSV/spreadsheet computational transforms (computed
# columns, sorting, aggregation) the CSV skill relies on.
RUN pip3 install --no-cache-dir \
      python-docx \
      openpyxl \
      python-pptx \
      pypdf \
      mammoth \
      lxml \
      pandas \
      numpy \
      tabulate

# Non-root user; workspace owned by it. The runner exec's as this user.
RUN useradd -m -u 10001 -d /workspace sandbox \
    && mkdir -p /workspace/uploads /workspace/outputs \
    && chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace

# Kept alive by the runner with `sleep infinity`; each tool call is a
# `docker exec` with its own timeout. Nothing listens on any port and the
# network is disabled at `docker run` time.
CMD ["sleep", "infinity"]
