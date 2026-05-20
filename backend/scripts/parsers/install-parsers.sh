#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[siraGPT] Installing document parsers..."
pip3 install -r "$SCRIPT_DIR/requirements.txt" 2>&1 || {
    echo "[siraGPT] pip failed. Try: python3 -m pip install -r $SCRIPT_DIR/requirements.txt"
    exit 1
}
echo "[siraGPT] Document parsers installed successfully."
