/**
 * elevenlabs-music
 *
 * Shared helper that turns a text description into an MP3 music track using
 * the ElevenLabs Music REST API (`POST /v1/music`) and returns metadata the
 * caller can surface as a chat artifact. Mirrors `elevenlabs-tts.js` so the
 * deterministic chat music endpoint (`/api/ai/generate-music`) and the
 * standalone `/api/elevenlabs/generate-music` route share ONE generation +
 * file-naming code path — no LLM tool-call dependency.
 *
 * The file is written to the same `uploads/audio` directory the elevenlabs
 * route serves from (`GET /api/elevenlabs/audio/:filename`), so the returned
 * `audioUrl` is immediately playable.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ELEVEN_API_BASE = process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io/v1';
const DEFAULT_MUSIC_MODEL = process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1';
const DEFAULT_OUTPUT_FORMAT = process.env.ELEVENLABS_MUSIC_FORMAT || 'mp3_44100_128';
const MUSIC_TIMEOUT_MS = Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS) || 120000;

// ElevenLabs music length bounds (seconds). Kept permissive; the caller
// (composer slider) usually sends 5–30s.
const MIN_SECONDS = 5;
const MAX_SECONDS = 300;

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isElevenLabsConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

function generatedMusicFilename(prefix = 'music', extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

function clampSeconds(value, fallback = 30) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

/**
 * Generate a music track via ElevenLabs Music and persist it to the served
 * audio directory.
 *
 * @param {object} opts
 * @param {string} opts.prompt            required music description
 * @param {number} [opts.durationSeconds] target length in seconds (default 30)
 * @param {string} [opts.modelId]         ElevenLabs music model (default music_v1)
 * @param {string} [opts.outputFormat]    ElevenLabs output format
 * @param {Function} [opts.fetchImpl]     injectable fetch (tests)
 * @returns {Promise<{filename,audioPath,audioUrl,sizeBytes,mime,durationSeconds,modelId}>}
 */
async function generateMusicFile({ prompt, durationSeconds, modelId, outputFormat, fetchImpl } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    const err = new Error('Prompt is required for music generation');
    err.code = 'PROMPT_REQUIRED';
    throw err;
  }
  if (!isElevenLabsConfigured()) {
    const err = new Error('ElevenLabs API key not configured');
    err.code = 'ELEVENLABS_NOT_CONFIGURED';
    throw err;
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    const err = new Error('fetch is not available in this runtime');
    err.code = 'NO_FETCH';
    throw err;
  }

  const seconds = clampSeconds(durationSeconds, 30);
  const resolvedModelId = String(modelId || '').trim() || DEFAULT_MUSIC_MODEL;
  const resolvedFormat = String(outputFormat || '').trim() || DEFAULT_OUTPUT_FORMAT;

  const resp = await doFetch(`${ELEVEN_API_BASE}/music`, {
    method: 'POST',
    signal: AbortSignal.timeout(MUSIC_TIMEOUT_MS),
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: cleanPrompt,
      music_length_ms: seconds * 1000,
      model_id: resolvedModelId,
      output_format: resolvedFormat,
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    const err = new Error(`ElevenLabs Music API error ${resp.status}: ${String(detail).slice(0, 300)}`);
    err.code = resp.status === 402 ? 'INSUFFICIENT_CREDITS'
      : resp.status === 400 ? 'INVALID_PARAMS'
        : 'API_ERROR';
    err.status = resp.status;
    throw err;
  }

  const audioBuffer = Buffer.from(await resp.arrayBuffer());
  if (!audioBuffer || audioBuffer.length === 0) {
    const err = new Error('ElevenLabs returned no audio');
    err.code = 'EMPTY_AUDIO';
    throw err;
  }

  ensureDir(audioDir);
  const filename = generatedMusicFilename('music');
  const audioPath = path.join(audioDir, filename);
  fs.writeFileSync(audioPath, audioBuffer);

  return {
    filename,
    audioPath,
    // Served by GET /api/elevenlabs/audio/:filename. The leading /api keeps
    // the frontend artifact-href resolver producing the correct absolute URL.
    audioUrl: `/api/elevenlabs/audio/${filename}`,
    sizeBytes: audioBuffer.length,
    mime: 'audio/mpeg',
    durationSeconds: seconds,
    modelId: resolvedModelId,
  };
}

module.exports = {
  generateMusicFile,
  isElevenLabsConfigured,
  clampSeconds,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_OUTPUT_FORMAT,
  audioDir,
};
