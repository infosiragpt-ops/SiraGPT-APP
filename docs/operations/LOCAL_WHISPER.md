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

Rebuild the backend image so the Dockerfile install runs:

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
