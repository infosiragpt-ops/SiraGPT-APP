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
# packages installed below (plus the NLTK data and spaCy models listed under
# python_data), the command-line tools and the Node modules. The agent prompt
# is built from a byte-identical copy in the backend
# (agent-runner/sandbox-capabilities.json). The build fails unless
# verify_env.py finds every entry AND the pytest suite in tests/ passes: one
# functional test per library/tool/module that produces a real file and
# reopens it, offline, as the sandbox user (tests/test_zz_catalog_coverage.py
# fails the build when a catalog entry has no test).
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
    NLTK_DATA=/usr/share/nltk_data \
    JUPYTER_PLATFORM_DIRS=1 \
    SIRA_CAPABILITIES=/opt/sira/capabilities.json

# LibreOffice renders and converts the documents; poppler-utils (pdftoppm/
# pdftotext/pdfinfo) rasterizes every page for the visual verification of
# agent-runner/sira_office.py. Metric-compatible fonts keep renders aligned
# with Word/PowerPoint: Carlito ≙ Calibri, Caladea ≙ Cambria, Liberation ≙
# Arial/Times New Roman/Courier New; Noto covers the remaining scripts and
# emoji. TeX Live (latex-recommended + Spanish + XeTeX + latexmk) compiles
# theses and papers; ImageMagick, MuPDF, exiftool, potrace and qrencode are
# the image/PDF command-line half; sox, mediainfo and espeak-ng (offline
# text-to-speech) join FFmpeg for media; qpdf + ghostscript + tesseract
# (eng/spa/por/fra/deu/ita) + unpaper + pngquant serve the PDF/OCR skills;
# pandoc, graphviz, librsvg, sqlite3, jq, ripgrep, tree, bc, gnupg and 7-Zip
# complete "generate any file". Pango/Cairo/HarfBuzz back WeasyPrint and
# CairoSVG; libmagic backs python-magic; libgomp backs LightGBM/XGBoost.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk file bc tree ripgrep \
      zip unzip p7zip-full xz-utils zstd gnupg \
      python3 python3-pip \
      nodejs npm \
      libreoffice --no-install-recommends \
      poppler-utils mupdf-tools qpdf ghostscript \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-por \
      tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita unpaper pngquant \
      texlive-latex-base texlive-latex-recommended texlive-fonts-recommended \
      texlive-lang-spanish texlive-xetex latexmk lmodern \
      pandoc graphviz librsvg2-bin imagemagick potrace qrencode \
      libimage-exiftool-perl \
      ffmpeg sox libsox-fmt-all mediainfo espeak-ng \
      sqlite3 jq \
      libcairo2 libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 \
      libmagic1 libgomp1 libglib2.0-0 \
      fonts-dejavu-core fonts-liberation fonts-liberation2 \
      fonts-crosextra-carlito fonts-crosextra-caladea \
      fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# ImageMagick ships with PDF/PS reading disabled; the sandbox has no network
# and runs as an unprivileged user, so let `convert` rasterize PDF pages like
# the recipes promise.
RUN sed -i 's/rights="none" pattern="\(PDF\|PS\|PS2\|PS3\|EPS\|XPS\)"/rights="read|write" pattern="\1"/' /etc/ImageMagick-6/policy.xml

COPY capabilities.json verify_env.py build_manifests.py /opt/sira/

# Every Python package comes from capabilities.json (python[].pip). Binary
# wheels only — nothing compiles inside this image, and a package that would
# need a compiler fails the build instead of shipping half-installed. The
# pure-Python names in python_sdist_ok have no wheel on PyPI and are the only
# ones allowed to install from source. build_manifests.py turns the catalog
# into the requirement/data lists this step consumes.
RUN python3 /opt/sira/build_manifests.py /tmp/sira-build \
    && pip3 install --no-cache-dir --only-binary=:all: \
         --no-binary="$(cat /tmp/sira-build/sdist-ok.txt)" \
         -r /tmp/sira-build/requirements.txt \
    && rm -rf /tmp/sira-build

# The data the catalog promises (python_data): the spaCy language models of
# the installed spaCy minor version, the NLTK corpora/models, and the Jupyter
# kernelspec nbclient/nbconvert need to execute notebooks.
RUN python3 /opt/sira/build_manifests.py /tmp/sira-build \
    && pip3 install --no-cache-dir -r /tmp/sira-build/spacy-models.txt \
    && python3 -m nltk.downloader -q -d /usr/share/nltk_data $(cat /tmp/sira-build/nltk-data.txt) \
    # The downloader leaves corpora zipped; nltk 3.10 opens some lookups only
    # from the directory (omw-1.4) and others only from the zip (vader_lexicon),
    # so keep both: extract every zip in place (read-only rootfs at run time).
    && find /usr/share/nltk_data -name '*.zip' -execdir unzip -oq '{}' \; \
    && chmod -R a+rX /usr/share/nltk_data \
    && python3 -m ipykernel install --name python3 --prefix /usr/local \
    && rm -rf /tmp/sira-build /workspace/.cache /workspace/.local

# Node writers for sheet/slide/document generation paths. The npm cache would
# land in /workspace (HOME) and be copied into every conversation volume:
# drop it.
# The pip package markdown-it-py also installs a `markdown-it` console script;
# the Node module (what the catalog promises) owns that bin name here.
RUN python3 -c "import json; print(' '.join(json.load(open('/opt/sira/capabilities.json'))['node']))" > /tmp/node-modules.txt \
    && rm -f /usr/local/bin/markdown-it \
    && npm install -g $(cat /tmp/node-modules.txt) \
    && npm cache clean --force \
    && rm -rf /workspace/.npm /tmp/node-modules.txt

# Non-root user; workspace owned by it. The runner exec's as this user.
RUN useradd -m -u 10001 -d /workspace sandbox \
    && mkdir -p /workspace/uploads /workspace/outputs \
    && chown -R sandbox:sandbox /workspace

# The suite is copied last so editing a test never invalidates the install layers.
COPY tests /opt/sira/tests

USER sandbox
WORKDIR /workspace

# The image is only usable if everything the agent is told about works:
# every import, binary, data set and Node module (verify_env.py), then the
# functional suite — one real file per library/tool, produced and reopened as
# the sandbox user, every catalog entry accounted for. The run also leaves
# the matplotlib font cache in /workspace/.cache: the root filesystem is
# read-only at run time, and Docker seeds each new conversation volume
# mounted on /workspace with this content, so the first chart of a
# conversation does not rescan every font.
RUN python3 /opt/sira/verify_env.py \
    && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider \
         --basetemp=/tmp/sira-tests --durations=20 /opt/sira/tests \
    && rm -rf /tmp/sira-tests /workspace/.config/libreoffice /workspace/.local/share/jupyter/runtime

# Kept alive by the runner with `sleep infinity`; each tool call is a
# `docker exec` with its own timeout. Nothing listens on any port and the
# network is disabled at `docker run` time.
CMD ["sleep", "infinity"]
