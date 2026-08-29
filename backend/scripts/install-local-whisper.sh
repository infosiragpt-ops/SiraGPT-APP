#!/usr/bin/env bash
# Install whisper.cpp (whisper-cli) + the multilingual ggml-base model.
# Used by backend/Dockerfile. Safe to re-run on the Lenovo host or inside
# a running backend container. No API keys. No OpenRouter.
#
# Env:
#   WHISPER_PREFIX       install prefix (default /usr/local, or ~/.local if not root)
#   WHISPER_MODEL_DIR    model directory (default $PREFIX/share/whisper)
#   WHISPER_CPP_REF      git tag/branch (default v1.7.5)
#   WHISPER_MODEL_URL    ggml model URL (default official ggml-base.bin)
#   WHISPER_SKIP_MODEL=1 compile the binary only
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  PREFIX="${WHISPER_PREFIX:-/usr/local}"
else
  PREFIX="${WHISPER_PREFIX:-${HOME}/.local}"
fi

BIN_DIR="${PREFIX}/bin"
MODEL_DIR="${WHISPER_MODEL_DIR:-${PREFIX}/share/whisper}"
REF="${WHISPER_CPP_REF:-v1.7.5}"
MODEL_URL="${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin}"
MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-base.bin}"
SRC_DIR="${TMPDIR:-/tmp}/whisper.cpp-src"
BUILD_DIR="${SRC_DIR}/build"

mkdir -p "${BIN_DIR}" "${MODEL_DIR}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd cmake || ! need_cmd make || ! need_cmd g++ || ! need_cmd git; then
  if need_cmd apk; then
    apk add --no-cache cmake make g++ git wget
  elif need_cmd apt-get; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      cmake make g++ git wget ca-certificates
  else
    echo "install-local-whisper: need cmake, make, g++, git on PATH" >&2
    exit 1
  fi
fi

download() {
  local url="$1" dest="$2"
  local attempt=1
  while [[ "${attempt}" -le 4 ]]; do
    if command -v wget >/dev/null 2>&1; then
      if wget -q --timeout=60 -O "${dest}.partial" "${url}"; then
        mv "${dest}.partial" "${dest}"
        return 0
      fi
    elif command -v curl >/dev/null 2>&1; then
      if curl -fsSL --retry 2 --max-time 60 -o "${dest}.partial" "${url}"; then
        mv "${dest}.partial" "${dest}"
        return 0
      fi
    else
      echo "install-local-whisper: wget or curl required" >&2
      return 1
    fi
    echo "install-local-whisper: download retry ${attempt} for ${url}" >&2
    attempt=$((attempt + 1))
    sleep $((attempt * 2))
  done
  rm -f "${dest}.partial"
  return 1
}

rm -rf "${SRC_DIR}"
git clone --depth 1 --branch "${REF}" https://github.com/ggerganov/whisper.cpp.git "${SRC_DIR}"
cmake -S "${SRC_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_SDL2=OFF
cmake --build "${BUILD_DIR}" --target whisper-cli -j"$(nproc 2>/dev/null || echo 2)"

CLI=""
for candidate in \
  "${BUILD_DIR}/bin/whisper-cli" \
  "${BUILD_DIR}/whisper-cli" \
  "${SRC_DIR}/build/bin/whisper-cli"
do
  if [[ -x "${candidate}" ]]; then
    CLI="${candidate}"
    break
  fi
done

if [[ -z "${CLI}" ]]; then
  echo "install-local-whisper: whisper-cli binary not found after build" >&2
  exit 1
fi

install -m 0755 "${CLI}" "${BIN_DIR}/whisper-cli"

if [[ "${WHISPER_SKIP_MODEL:-0}" != "1" ]]; then
  if [[ ! -s "${MODEL_DIR}/${MODEL_NAME}" ]]; then
    download "${MODEL_URL}" "${MODEL_DIR}/${MODEL_NAME}"
  fi
  if [[ ! -s "${MODEL_DIR}/${MODEL_NAME}" ]]; then
    echo "install-local-whisper: model missing at ${MODEL_DIR}/${MODEL_NAME}" >&2
    exit 1
  fi
fi

rm -rf "${SRC_DIR}"

echo "install-local-whisper: ok bin=${BIN_DIR}/whisper-cli model=${MODEL_DIR}/${MODEL_NAME}"
