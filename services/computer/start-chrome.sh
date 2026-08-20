#!/bin/bash
set -euo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/workspace}"

# Required flags (do not drop): --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222
# --remote-debugging-address=0.0.0.0 lets the orchestrator map CDP out of the container.
exec google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --user-data-dir="$HOME/.chrome" \
  --no-first-run \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-features=TranslateUI \
  about:blank
