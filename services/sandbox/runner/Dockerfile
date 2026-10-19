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
# What the image ships is declared ONCE in capabilities.json: the Python
# packages installed below, the command-line tools and the Node modules. The
# agent prompt is built from a byte-identical copy in the backend
# (agent-runner/sandbox-capabilities.json), and the build fails unless
# verify_env.py finds every entry and smoke_formats.py produces and reopens a
# real file of every advertised format, offline, as the sandbox user.
#
# Build (on the Docker host, see services/sandbox/DEPLOY.md):
#   docker build -t siragpt-doc-sandbox:latest services/sandbox/runner
#
# Override the image name via SIRAGPT_DOC_SANDBOX_IMAGE.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/workspace \
    NODE_PATH=/usr/local/lib/node_modules \
    MPLBACKEND=Agg \
    SIRA_CAPABILITIES=/opt/sira/capabilities.json

# LibreOffice renders and converts the documents; poppler-utils (pdftoppm/
# pdftotext/pdfinfo) rasterizes every page for the visual verification of
# agent-runner/sira_office.py. Metric-compatible fonts keep renders aligned
# with Word/PowerPoint: Carlito ≙ Calibri, Caladea ≙ Cambria, Liberation ≙
# Arial/Times New Roman/Courier New; Noto covers the remaining scripts.
# qpdf + ghostscript + tesseract serve the PDF skills; FFmpeg converts audio
# and video within this same offline sandbox. pandoc (Markdown/HTML ↔ docx,
# odt, epub), graphviz (diagrams), librsvg (SVG → PNG/PDF), sqlite3, jq and
# 7-Zip are the command-line half of "generate any file". Pango/Cairo/
# HarfBuzz back WeasyPrint (HTML + CSS → PDF) and CairoSVG.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk file \
      zip unzip p7zip-full xz-utils \
      python3 python3-pip \
      nodejs npm \
      libreoffice --no-install-recommends \
      poppler-utils \
      ffmpeg \
      qpdf \
      ghostscript \
      tesseract-ocr \
      tesseract-ocr-spa \
      pandoc \
      graphviz \
      librsvg2-bin \
      sqlite3 \
      jq \
      libcairo2 \
      libpango-1.0-0 \
      libpangoft2-1.0-0 \
      libharfbuzz-subset0 \
      fonts-dejavu-core \
      fonts-liberation \
      fonts-liberation2 \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

COPY capabilities.json verify_env.py smoke_formats.py /opt/sira/

# Every Python package comes from capabilities.json (python[].pip), binary
# wheels only: nothing compiles inside this image, and a package that would
# need a compiler fails the build instead of shipping half-installed.
# odfpy is the one pure-Python sdist without a wheel.
RUN python3 -c "import json; print('\n'.join(p['pip'] for p in json.load(open('/opt/sira/capabilities.json'))['python']))" > /tmp/requirements.txt \
    && pip3 install --no-cache-dir --only-binary=:all: --no-binary=odfpy -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt

# Node writers for sheet/slide generation paths (exceljs, pptxgenjs, docx).
# The npm cache would land in /workspace (HOME) and be copied into every
# conversation volume: drop it.
RUN npm install -g docx exceljs pptxgenjs \
    && npm cache clean --force \
    && rm -rf /workspace/.npm

# Non-root user; workspace owned by it. The runner exec's as this user.
RUN useradd -m -u 10001 -d /workspace sandbox \
    && mkdir -p /workspace/uploads /workspace/outputs \
    && chown -R sandbox:sandbox /workspace

USER sandbox
WORKDIR /workspace

# The image is only usable if everything the agent is told about works:
# every import and binary (verify_env.py), then one real file per format,
# produced and reopened as the sandbox user (smoke_formats.py). The run also
# leaves the matplotlib font cache in /workspace/.cache: the root filesystem
# is read-only at run time, and Docker seeds each new conversation volume
# mounted on /workspace with this content, so the first chart of a
# conversation does not rescan every font.
RUN python3 /opt/sira/verify_env.py \
    && python3 /opt/sira/smoke_formats.py /tmp/sira-smoke \
    && rm -rf /tmp/sira-smoke /workspace/.config/libreoffice

# Kept alive by the runner with `sleep infinity`; each tool call is a
# `docker exec` with its own timeout. Nothing listens on any port and the
# network is disabled at `docker run` time.
CMD ["sleep", "infinity"]
