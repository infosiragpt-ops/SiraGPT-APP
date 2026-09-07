# Local Whisper (no API key)

WhatsApp voice notes (`.ogg` / opus / `.m4a`) are transcribed on the backend
without `OPENAI_API_KEY`. OpenAI Whisper remains an optional faster path and
is used only when a key is present **and** the request succeeds. A 401/403
or missing key falls back to local Whisper.

User-facing failures are Spanish and secret-safe (`Transcripción no disponible.`).
Provider bodies that contain `sk-` / `sk-proj-` / `Bearer` never enter chat.

## Runtime (backend container)

The backend image installs [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
(`whisper-cli`) and the multilingual **base** model via
`backend/scripts/install-local-whisper.sh` during `backend/Dockerfile`.

| Env | Default | Role |
|-----|---------|------|
| `WHISPER_LANGUAGE` | `es` | Language hint when unset (Peru / Spanish notes) |
| `WHISPER_CPP_BIN` | `/usr/local/bin/whisper-cli` | Local binary |
| `WHISPER_CPP_MODEL` | `/usr/local/share/whisper/ggml-base.bin` | ggml base (~142MB) |
| `LOCAL_WHISPER_MODEL` | `base` | Name used by the optional Python fallback |
| `LOCAL_WHISPER_TIMEOUT_MS` | `180000` | Per-file timeout |
| `FFMPEG_PATH` | `ffmpeg` | Already in the backend image |

`ffmpeg` converts any accepted MIME (`audio/ogg`, `audio/opus`, `application/ogg`,
m4a, mp3, wav, mp4, …) to 16 kHz mono WAV before Whisper.

Alpine musl needs OpenMP off (`-DGGML_OPENMP=OFF`) plus no-gpu (`-ng` / `-t 1`);
OpenMP + GPU init segfault after `whisper_model_load`.

## Publish / Lenovo host

`install-local-whisper.sh` skips HuggingFace when `ggml-base.bin` is already
present and non-empty (destination, `/tmp/whisper-seed/`, `/tmp/`, or
`WHISPER_SEED_FILE`). Live images already ship
`/usr/local/share/whisper/ggml-base.bin` (~142MB).

**Preferred Lenovo rebuild** — copy the cached bin into the backend build
context and set `BUNDLE_WHISPER_MODEL=1`. That selects the `whisper-seed-1`
stage (`COPY ggml-base.bin`) so the install never hits HuggingFace (avoids
429 during `docker compose build`):

```bash
# From a running backend container, or any host path that already has the bin:
docker cp <backend-container>:/usr/local/share/whisper/ggml-base.bin backend/ggml-base.bin

BUNDLE_WHISPER_MODEL=1 docker compose -f docker-compose.prod.yml build backend
# equivalent:
# docker compose -f docker-compose.prod.yml build \
#   --build-arg BUNDLE_WHISPER_MODEL=1 backend
```

Do not commit `ggml-base.bin`. `backend/.dockerignore` must not exclude it
(the file is gitignored only).

**Alternate:** pass an internal or `file://` URL instead of HuggingFace:

```bash
docker compose -f docker-compose.prod.yml build \
  --build-arg WHISPER_MODEL_URL=file:///tmp/whisper-seed/ggml-base.bin \
  backend
```

Default (CI / first install) still downloads from HuggingFace:

```bash
docker compose -f docker-compose.prod.yml build backend
```

To install (or repair) on a running Linux host / container without rebuilding:

```bash
sh backend/scripts/install-local-whisper.sh
```

Optional Python fallback (Debian/Ubuntu, not required in Alpine):

```bash
pip install faster-whisper
# backend/scripts/local-whisper.py is invoked automatically if whisper.cpp is missing
```

Do not put API keys in this path. Do not use OpenRouter for transcription.
