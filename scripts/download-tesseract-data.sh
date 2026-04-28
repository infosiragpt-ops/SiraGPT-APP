#!/usr/bin/env bash
set -euo pipefail

# Downloads Tesseract trained-data files used by the OpenClaw OCR engine.
# Skipped automatically when both files are already present.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="https://github.com/tesseract-ocr/tessdata_fast/raw/main"
LANGS=(eng spa)

for lang in "${LANGS[@]}"; do
  dest="${ROOT}/${lang}.traineddata"
  if [[ -f "${dest}" ]]; then
    echo "✓ ${lang}.traineddata already present"
    continue
  fi
  echo "↓ downloading ${lang}.traineddata ..."
  curl -fsSL --retry 3 -o "${dest}" "${BASE_URL}/${lang}.traineddata"
done

echo "Tesseract trained-data ready in ${ROOT}"
