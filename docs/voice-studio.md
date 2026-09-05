# Sira Voz — VoiceStudio integration (local, free)

[VoiceStudio](https://github.com/debpalash/VoiceStudio) (AGPL-3.0, open
source) gives SiraGPT voice cloning, video dubbing, transcription and
audiobooks that run **entirely on our own server** — no third-party account,
no per-character billing, +600 languages. In the product it is called
**Sira Voz** and it is free on every plan.

## Architecture

```
browser ──/api/voice-studio/*──▶ iliagpt-backend ──http://siragpt-voicestudio:3900──▶ VoiceStudio container
        ──/api/ai/generate-speech (model "sira-voz") ─┘   (OpenAI-compatible audio API, profiles, dub, audiobook)
```

- **Container**: `palashdeb/omnivoice-studio:<pinned>` as compose service
  `voicestudio` (see `deploy/iliagpt/voicestudio.compose.yaml`). Internal
  network only, never published. CPU-only on the Lenovo.
- **Backend client**: `backend/src/services/ai/voicestudio-client.js` —
  zero-dependency, Bearer auth (`VOICESTUDIO_API_KEY`), injectable fetch.
- **Router**: `backend/src/routes/voice-studio.js` → `/api/voice-studio`
  (status, voices/clone/preview/delete, speech preview, transcriptions,
  jobs: dub + audiobook, download, subtitles). Authenticated, **no paywall**.
- **Jobs**: `backend/src/services/voice-studio/jobs.js` (in-process queue,
  `voice_studio_jobs` table, per-user limit 1 active, global concurrency
  `VOICESTUDIO_JOB_CONCURRENCY` = 1) + `pipelines.js` (dub / audiobook /
  transcription) + `translate.js` (DeepSeek ladder → NLLB fallback) +
  `chat-persistence.js` (results become chat messages).
- **Voices**: `voice_profiles` maps each VoiceStudio profile to its SiraGPT
  owner; users only ever see their own voices.
- **Composer**: the Voz picker lists the `sira-voz` AUDIO row ("Sira Voz");
  `/api/ai/generate-speech` routes it to VoiceStudio (long texts are chunked
  and joined with ffmpeg → mp3). The «Estudio de voz» modal
  (`components/voice/voice-studio-modal.tsx`) hosts clone / dub /
  transcribe / audiobook / jobs.
- **Dictation** (`POST /api/elevenlabs/speech-to-text`): free for every plan —
  local whisper.cpp first, VoiceStudio WhisperX second; ElevenLabs Scribe only
  for paid plans with a key.
- **Upload transcription ladder** (`audio-transcriber.js`): add `voicestudio`
  to `TRANSCRIBE_PROVIDERS` to prefer WhisperX large-v3 over the bundled
  whisper.cpp base model (opt-in; slower on CPU).

## Backend env (names only — values live in the deploy `.env`)

| Var | Meaning |
|---|---|
| `VOICESTUDIO_URL` | `http://siragpt-voicestudio:3900` in prod |
| `VOICESTUDIO_API_KEY` | same value as the container's `OMNIVOICE_API_KEY` |
| `VOICESTUDIO_TTS_MODEL` | `tts-1` (active engine) or an engine id |
| `VOICESTUDIO_TTS_CHUNK_CHARS` | chunk size for long narrations (default 3000) |
| `VOICESTUDIO_JOB_CONCURRENCY` | parallel studio jobs (default 1) |
| `VOICESTUDIO_MAX_ACTIVE_JOBS_PER_USER` | default 1 |
| `VOICESTUDIO_MAX_VOICES_PER_USER` | default 20 |

## Deploy / operate (Lenovo)

1. Generate a key on the box (never in chat): `head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'`.
2. Append `VOICESTUDIO_API_KEY=…` and `VOICESTUDIO_URL=http://siragpt-voicestudio:3900` to `/home/user/deployments/iliagpt/.env`.
3. Paste the service + volumes from `deploy/iliagpt/voicestudio.compose.yaml` into `compose.yaml`; `docker compose config --quiet`; `docker compose up -d voicestudio`.
4. Wait for `/health` → `{"status":"ok","device":"cpu"}` (first boot ≈ 1–3 min).
5. Pre-download the models from inside the network (admin key):
   `POST /models/install {"repo_id":"k2-fsa/OmniVoice"}` and `{"repo_id":"Systran/faster-whisper-large-v3"}`; follow `GET /setup/download-stream`.
6. Recreate the backend so it reads the new env: `docker compose up -d --no-deps --force-recreate backend`.
7. Verify: `GET /api/voice-studio/status` (auth) → `configured:true, ok:true`.

## Licensing notes

VoiceStudio is AGPL-3.0: we run it **unmodified** as a separate network
service (its source is public upstream), and SiraGPT talks to it over HTTP —
the copyleft does not extend to SiraGPT. Model weights keep their own terms:
the default OmniVoice weights are **CC-BY-NC**; VoxCPM2 / CosyVoice 3 /
MOSS-TTS are Apache-2.0 and can be selected in VoiceStudio's engine settings
(`OMNIVOICE_TTS_BACKEND`) if a commercial-clean default is preferred.
