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

// Values that mean "no preference" — excluded from the composed prompt so they
// don't bias ElevenLabs toward a literal "auto/none/balanced" reading.
const NEUTRAL_STYLE = new Set(['', 'auto']);
const NEUTRAL_MOOD = new Set(['', 'balanced']);
const NEUTRAL_EFFECT = new Set(['', 'none']);

/**
 * Fold the composer's visible music settings (style/mood/effect/influence)
 * into the ElevenLabs prompt so each control actually shapes the output.
 * Neutral/default values are skipped. `influence` is the prompt-adherence
 * slider (0..1): high → follow the description literally, low → free inspiration.
 */
function composeMusicPrompt(text, { style, mood, effect, influence } = {}) {
  const base = String(text || '').trim();
  const parts = base ? [base] : [];
  const s = String(style || '').trim();
  const m = String(mood || '').trim();
  const e = String(effect || '').trim();
  if (s && !NEUTRAL_STYLE.has(s.toLowerCase())) parts.push(`Estilo musical: ${s}.`);
  if (m && !NEUTRAL_MOOD.has(m.toLowerCase())) parts.push(`Mood: ${m}.`);
  if (e && !NEUTRAL_EFFECT.has(e.toLowerCase())) parts.push(`Producción / efecto: ${e}.`);
  const inf = Number(influence);
  if (Number.isFinite(inf)) {
    if (inf >= 0.66) parts.push('Sigue la descripción de forma fiel y literal.');
    else if (inf <= 0.33) parts.push('Usa la descripción como inspiración general, con libertad creativa.');
  }
  return parts.join(' ').trim();
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
    // ElevenLabs signals "out of credits / over the key's quota" as a 402 OR a
    // 401 with code `quota_exceeded` ("This request exceeds your API key …").
    // Long tracks cost the most, so this is the common failure for 3–4 min
    // requests — surface it as a clear, actionable INSUFFICIENT_CREDITS.
    const lowerDetail = String(detail).toLowerCase();
    const isQuota = resp.status === 402
      || /quota_exceeded|exceeds your api key|insufficient|out of credit|not enough credit/.test(lowerDetail);
    const err = new Error(`ElevenLabs Music API error ${resp.status}: ${String(detail).slice(0, 300)}`);
    err.code = isQuota ? 'INSUFFICIENT_CREDITS'
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
  composeMusicPrompt,
  isElevenLabsConfigured,
  clampSeconds,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_OUTPUT_FORMAT,
  audioDir,
};
