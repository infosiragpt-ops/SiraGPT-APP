#!/bin/sh
# Install the Silero VAD model for whisper.cpp next to the whisper model.
# Used by backend/Dockerfile. POSIX sh (Alpine). Safe to re-run.
#
# whisper.cpp itself is NOT touched: the image pins v1.7.5, which has no
# --vad. local-whisper-engine feature-detects `--vad` from `whisper-cli -h`
# and only uses this file with a build that supports it and WHISPER_CPP_VAD=1.
#
# Env:
#   WHISPER_VAD_MODEL_URL     download URL (default ggml-org/whisper-vad on
#                             HuggingFace at a pinned revision, never `main`);
#                             file:// and absolute paths copy locally (no
#                             network)
#   WHISPER_VAD_MODEL_SHA256  expected sha256 (default: the pinned v5.1.2 hash)
#   WHISPER_VAD_MODEL_DIR     destination dir (default /usr/local/share/whisper)
#   WHISPER_VAD_MODEL_NAME    file name (default ggml-silero-v5.1.2.bin)
#   WHISPER_VAD_REQUIRED=1    fail when the model cannot be downloaded
#                             (default: an optional model, so a network
#                             failure only prints a WARN and exits 0)
#
# A checksum mismatch ALWAYS fails (exit 3) and never leaves the file behind:
# an unverified model is never shipped.
set -eu
(set -o pipefail) 2>/dev/null && set -o pipefail

VAD_URL="${WHISPER_VAD_MODEL_URL:-https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin}"
VAD_SHA256="${WHISPER_VAD_MODEL_SHA256:-29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf}"
VAD_DIR="${WHISPER_VAD_MODEL_DIR:-/usr/local/share/whisper}"
VAD_NAME="${WHISPER_VAD_MODEL_NAME:-ggml-silero-v5.1.2.bin}"
VAD_REQUIRED="${WHISPER_VAD_REQUIRED:-0}"
VAD_ATTEMPTS="${WHISPER_VAD_ATTEMPTS:-3}"

log() {
  echo "install-whisper-vad: $*" >&2
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

# fetch URL DEST: 0 when DEST holds the downloaded bytes, 1 otherwise.
# POSIX sh has no `local`: every variable here is prefixed so a call never
# clobbers the caller's.
fetch() {
  f_url="$1"
  f_dest="$2"
  f_src=""
  case "${f_url}" in
    file://*) f_src="${f_url#file://}" ;;
    /*) f_src="${f_url}" ;;
  esac
  if [ -n "${f_src}" ]; then
    if [ -s "${f_src}" ]; then
      cp -f "${f_src}" "${f_dest}"
      return 0
    fi
    log "local model missing at ${f_src}"
    return 1
  fi
  f_attempt=1
  while [ "${f_attempt}" -le "${VAD_ATTEMPTS}" ]; do
    if command -v wget >/dev/null 2>&1; then
      if wget -q --timeout=60 -O "${f_dest}" "${f_url}"; then
        return 0
      fi
    elif command -v curl >/dev/null 2>&1; then
      if curl -fsSL --max-time 120 -o "${f_dest}" "${f_url}"; then
        return 0
      fi
    else
      log "wget or curl required"
      return 1
    fi
    rm -f "${f_dest}"
    log "download retry ${f_attempt} for ${f_url}"
    f_attempt=$((f_attempt + 1))
    if [ "${f_attempt}" -le "${VAD_ATTEMPTS}" ]; then
      sleep $((f_attempt * 3))
    fi
  done
  return 1
}

install_vad() {
  v_dest="${VAD_DIR}/${VAD_NAME}"
  v_partial="${v_dest}.partial"
  mkdir -p "${VAD_DIR}"

  if [ -s "${v_dest}" ]; then
    v_have="$(sha256_of "${v_dest}" || true)"
    if [ "${v_have}" = "${VAD_SHA256}" ]; then
      chmod 0644 "${v_dest}"
      log "model already present and verified (${v_dest})"
      return 0
    fi
    log "existing ${v_dest} does not match the pinned checksum; replacing it"
    rm -f "${v_dest}"
  fi

  rm -f "${v_partial}"
  if ! fetch "${VAD_URL}" "${v_partial}"; then
    rm -f "${v_partial}"
    if [ "${VAD_REQUIRED}" = "1" ]; then
      log "download failed and WHISPER_VAD_REQUIRED=1"
      return 2
    fi
    log "WARN: Silero VAD model not downloaded; local whisper runs without VAD"
    return 0
  fi

  v_got="$(sha256_of "${v_partial}" || true)"
  if [ -z "${v_got}" ]; then
    rm -f "${v_partial}"
    log "no sha256 tool available; refusing to install an unverified model"
    return 3
  fi
  if [ "${v_got}" != "${VAD_SHA256}" ]; then
    rm -f "${v_partial}"
    log "checksum mismatch for ${VAD_NAME} (expected ${VAD_SHA256}, got ${v_got})"
    return 3
  fi
  mv -f "${v_partial}" "${v_dest}"
  chmod 0644 "${v_dest}"
  log "installed ${v_dest} (sha256 verified)"
  return 0
}

if [ "${WHISPER_VAD_SOURCE_ONLY:-0}" != "1" ]; then
  install_vad
fi
