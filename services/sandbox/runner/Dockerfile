# SiraGPT document-agent sandbox image — the ONLY builder of
# `siragpt-doc-sandbox:latest` (docs/specs/edicion-milimetrica/SPEC.md,
# hallazgo 13: `infra/sandbox/Dockerfile` used to build the same tag with a
# different package set, so production fonts depended on which one ran last).
#
# One EPHEMERAL container per document task (started by
# backend/src/services/doc-agent/sandbox.js — directly or through the
# sandbox microservice — with: --network none, --memory 1g, --cpus 1,
# --pids-limit 256, --cap-drop ALL, --security-opt no-new-privileges,
# --user sandbox, auto-remove). The agent gets bash/read/write/str_replace/
# list tools bound to /workspace; uploads are mounted under
# /workspace/uploads and deliverables must be written to /workspace/outputs.
#
# Build (on the Docker host, see services/sandbox/DEPLOY.md):
#   docker build -t siragpt-doc-sandbox:latest services/sandbox/runner
#
# Override the image name via SIRAGPT_DOC_SANDBOX_IMAGE.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    HOME=/workspace

# LibreOffice renders the documents; poppler-utils (pdftoppm/pdftotext/
# pdfinfo) rasterizes every page for the visual verification of
# agent-runner/sira_office.py. Metric-compatible fonts keep renders aligned
# with Word/PowerPoint: Carlito ≙ Calibri, Caladea ≙ Cambria, Liberation ≙
# Arial/Times New Roman/Courier New. qpdf + tesseract serve the PDF skills
# (structural edits, OCR of scanned PDFs).
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk \
      zip unzip \
      python3 python3-pip \
      nodejs npm \
      libreoffice --no-install-recommends \
      poppler-utils \
      qpdf \
      tesseract-ocr \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-liberation2 \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/*

# Document-manipulation libraries the skills prompt teaches the model to use.
# Reads use the high-level libs; surgical writes use direct XML (lxml) so
# charts/images/macros survive. pandas + numpy power the CSV/spreadsheet
# transforms; pillow builds the before/after composites of sira_office.py;
# PyMuPDF covers PDF micro-edits (and is the rasterizer fallback).
RUN pip3 install --no-cache-dir \
      python-docx \
      openpyxl \
      python-pptx \
      pypdf \
      pymupdf \
      pdfplumber \
      pillow \
      mammoth \
      lxml \
      pandas \
      numpy \
      tabulate

# Node writers for sheet/slide generation paths (exceljs, pptxgenjs, docx).
RUN npm install -g docx exceljs pptxgenjs

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
