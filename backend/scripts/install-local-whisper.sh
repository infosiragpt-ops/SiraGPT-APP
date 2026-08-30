#!/bin/sh
# Install whisper.cpp (whisper-cli) + the multilingual ggml-base model.
# Used by backend/Dockerfile. POSIX sh — Alpine images have no bash.
# Safe to re-run on the Lenovo host or inside a running backend container.
# No API keys. No OpenRouter.
#
# Env:
#   WHISPER_PREFIX       install prefix (default /usr/local, or ~/.local if not root)
#   WHISPER_MODEL_DIR    model directory (default $PREFIX/share/whisper)
#   WHISPER_CPP_REF      git tag/branch (default v1.7.5)
#   WHISPER_MODEL_URL    ggml model URL (default official ggml-base.bin)
#   WHISPER_SKIP_MODEL=1 compile the binary only
set -eu
# pipefail when the shell supports it (ash on Alpine, bash)
(set -o pipefail) 2>/dev/null && set -o pipefail

if [ "$(id -u)" -eq 0 ]; then
  PREFIX="${WHISPER_PREFIX:-/usr/local}"
else
  PREFIX="${WHISPER_PREFIX:-${HOME}/.local}"
fi

BIN_DIR="${PREFIX}/bin"
LIB_DIR="${PREFIX}/lib"
MODEL_DIR="${WHISPER_MODEL_DIR:-${PREFIX}/share/whisper}"
REF="${WHISPER_CPP_REF:-v1.7.5}"
MODEL_URL="${WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin}"
MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-base.bin}"
SRC_DIR="${TMPDIR:-/tmp}/whisper.cpp-src"
BUILD_DIR="${SRC_DIR}/build"

mkdir -p "${BIN_DIR}" "${LIB_DIR}" "${MODEL_DIR}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if ! need_cmd cmake || ! need_cmd make || ! need_cmd g++ || ! need_cmd git; then
  if need_cmd apk; then
    apk add --no-cache cmake make g++ git wget linux-headers
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
  url="$1"
  dest="$2"
  attempt=1
  while [ "${attempt}" -le 4 ]; do
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

copy_shared_libs() {
  # whisper-cli is dynamically linked against libwhisper / libggml*. Copy the
  # real .so files and recreate soname symlinks with relative targets so they
  # still resolve after the build tree is deleted.
  find "${BUILD_DIR}" \( -name 'libwhisper.so*' -o -name 'libggml*.so*' \) -type f 2>/dev/null \
    | while IFS= read -r lib; do
        install -m 0755 "${lib}" "${LIB_DIR}/$(basename "${lib}")"
      done
  find "${BUILD_DIR}" \( -name 'libwhisper.so*' -o -name 'libggml*.so*' \) -type l 2>/dev/null \
    | while IFS= read -r link; do
        name=$(basename "${link}")
        target=$(basename "$(readlink "${link}")")
        ln -sfn "${target}" "${LIB_DIR}/${name}"
      done
}

register_dynamic_libs() {
  # glibc: ldconfig updates the cache. musl (Alpine): default search already
  # includes /usr/local/lib; if a path file exists, append LIB_DIR without
  # replacing compiled-in defaults.
  if [ "$(id -u)" -eq 0 ]; then
    arch=$(uname -m)
    musl_path="/etc/ld-musl-${arch}.path"
    if [ -f "${musl_path}" ] && ! grep -qx "${LIB_DIR}" "${musl_path}" 2>/dev/null; then
      echo "${LIB_DIR}" >> "${musl_path}"
    fi
    if command -v ldconfig >/dev/null 2>&1; then
      # Alpine busybox ldconfig is best-effort; whisper-cli -h is the real gate.
      ldconfig "${LIB_DIR}" 2>/dev/null || ldconfig || true
    fi
  fi
}

rm -rf "${SRC_DIR}"
git clone --depth 1 --branch "${REF}" https://github.com/ggerganov/whisper.cpp.git "${SRC_DIR}"
# Alpine musl: OpenMP + native/GPU backends segfault after whisper_model_load
# (n_langs = 99). Static CPU-only binary avoids /usr/lib ggml and libgomp.
cmake -S "${SRC_DIR}" -B "${BUILD_DIR}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
  -DCMAKE_INSTALL_RPATH="${LIB_DIR}" \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_CUDA=OFF \
  -DGGML_VULKAN=OFF \
  -DGGML_METAL=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_SDL2=OFF
cmake --build "${BUILD_DIR}" --target whisper-cli -j"$(nproc 2>/dev/null || echo 2)"
# Best-effort cmake install (binary + shared libs). Manual copy below is the
# source of truth if this target set is incomplete.
cmake --install "${BUILD_DIR}" --prefix "${PREFIX}" >/tmp/whisper-cmake-install.log 2>&1 \
  || echo "install-local-whisper: cmake --install incomplete; copying artifacts by hand" >&2

CLI=""
for candidate in \
  "${BIN_DIR}/whisper-cli" \
  "${BUILD_DIR}/bin/whisper-cli" \
  "${BUILD_DIR}/whisper-cli" \
  "${SRC_DIR}/build/bin/whisper-cli"
do
  if [ -x "${candidate}" ]; then
    CLI="${candidate}"
    break
  fi
done

if [ -z "${CLI}" ]; then
  echo "install-local-whisper: whisper-cli binary not found after build" >&2
  exit 1
fi

# cmake --install may already have placed the binary at $BIN_DIR/whisper-cli.
# BusyBox/GNU install refuse a same-file copy ("are the same file") and that
# aborted the Lenovo publish of #499. Skip the copy when source == dest.
dest="${BIN_DIR}/whisper-cli"
if [ "${CLI}" = "${dest}" ]; then
  echo "install-local-whisper: whisper-cli already at ${dest}; skipping copy" >&2
else
  install -m 0755 "${CLI}" "${dest}"
fi
copy_shared_libs
register_dynamic_libs

if [ "${WHISPER_SKIP_MODEL:-0}" != "1" ]; then
  if [ ! -s "${MODEL_DIR}/${MODEL_NAME}" ]; then
    download "${MODEL_URL}" "${MODEL_DIR}/${MODEL_NAME}"
  fi
  if [ ! -s "${MODEL_DIR}/${MODEL_NAME}" ]; then
    echo "install-local-whisper: model missing at ${MODEL_DIR}/${MODEL_NAME}" >&2
    exit 1
  fi
fi

# Fail the image build if the binary cannot start (missing .so is the usual cause).
export LD_LIBRARY_PATH="${LIB_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
help_out="$("${BIN_DIR}/whisper-cli" -h 2>&1 || true)"
case "${help_out}" in
  *[Uu]sage*|*whisper*|*model*)
    ;;
  *)
    echo "install-local-whisper: whisper-cli -h failed (missing shared libs?)" >&2
    echo "${help_out}" >&2
    ldd "${BIN_DIR}/whisper-cli" >&2 || true
    ls -l "${LIB_DIR}"/libwhisper.so* "${LIB_DIR}"/libggml*.so* >&2 || true
    exit 1
    ;;
esac

rm -rf "${SRC_DIR}"

echo "install-local-whisper: ok bin=${BIN_DIR}/whisper-cli lib=${LIB_DIR} model=${MODEL_DIR}/${MODEL_NAME}"
