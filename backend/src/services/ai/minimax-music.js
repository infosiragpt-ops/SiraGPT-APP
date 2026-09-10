/**
 * minimax-music
 *
 * Music generation via the OFFICIAL MiniMax music API
 * (`POST https://api.minimax.io/v1/music_generation`, Bearer MINIMAX_API_KEY).
 * Mirrors `elevenlabs-music.js` (same audio dir + file naming + return shape)
 * so `/api/ai/generate-music` can pick it transparently.
 *
 * Contract (mirrors extensions/upstream/openclaw/minimax/music-generation-provider.ts):
 * request  { model, prompt, lyrics_optimizer:true, output_format:"url",
 *            audio_setting:{ sample_rate:44100, bitrate:256000, format:"mp3" } }
 * response { base_resp:{ status_code:0 }, audio | audio_url | data:{...} }
 *   → download audio_url (or decode inline hex/base64 audio) → MP3 file.
 *
 * Env:
 *   MINIMAX_API_KEY          (required)  MiniMax platform key
 *   MINIMAX_API_BASE         (optional)  default https://api.minimax.io
 *   MINIMAX_MUSIC_MODEL      (optional)  default music-2.6
 *   MINIMAX_MUSIC_TIMEOUT_MS (optional)  default 180000
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout, throwIfAborted } = require('../../utils/abort-signal');

const MINIMAX_API_BASE = (process.env.MINIMAX_API_BASE || 'https://api.minimax.io').replace(/\/+$/, '');
const MINIMAX_MUSIC_MODEL = process.env.MINIMAX_MUSIC_MODEL || process.env.MIMO_MUSIC_MODEL_ID || 'music-2.6';
const MINIMAX_TIMEOUT_MS = Number(process.env.MINIMAX_MUSIC_TIMEOUT_MS) || 180000;

const MIN_SECONDS = 5;
const MAX_SECONDS = 300;

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isMinimaxConfigured() {
  return Boolean(process.env.MINIMAX_API_KEY);
}

function generatedMusicFilename(prefix = 'minimax', extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

function clampSeconds(value, fallback = 30) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

function classifyMinimaxError(status, detail) {
  const lower = String(detail || '').toLowerCase();
  if (status === 402 || /quota|insufficient|credit|exceeds your|balance/.test(lower)) return 'INSUFFICIENT_CREDITS';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'INVALID_PARAMS';
  if (status === 404) return 'MODEL_NOT_FOUND';
  return 'API_ERROR';
}

function decodePossibleBinary(data) {
  const trimmed = String(data || '').trim();
  if (/^[0-9a-f]+$/iu.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length > 0) {
    return Buffer.from(trimmed, 'hex');
  }
  return Buffer.from(trimmed, 'base64');
}

/**
 * Generate a music track via MiniMax and persist it to the served directory.
 *
 * @param {object} opts
 * @param {string} opts.prompt            required music description
 * @param {number} [opts.durationSeconds] metadata hint (MiniMax renders full songs)
 * @param {string} [opts.model]           MiniMax music model (default music-2.6)
 * @param {Function} [opts.fetchImpl]     injectable fetch (tests)
 * @param {AbortSignal} [opts.signal]     user/request cancellation signal
 */
async function generateMinimaxMusicFile({ prompt, durationSeconds, model, fetchImpl, signal } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    const err = new Error('Prompt is required for music generation');
    err.code = 'PROMPT_REQUIRED';
    throw err;
  }
  if (!isMinimaxConfigured()) {
    const err = new Error('MiniMax API key not configured');
    err.code = 'MINIMAX_NOT_CONFIGURED';
    throw err;
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    const err = new Error('fetch is not available in this runtime');
    err.code = 'NO_FETCH';
    throw err;
  }

  const seconds = clampSeconds(durationSeconds, 30);
  const resolvedModel = String(model || '').trim() || MINIMAX_MUSIC_MODEL;
  throwIfAborted(signal);

  const resp = await doFetch(`${MINIMAX_API_BASE}/v1/music_generation`, {
    method: 'POST',
    signal: signalWithTimeout(signal, MINIMAX_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: resolvedModel,
      prompt: cleanPrompt,
      lyrics_optimizer: true,
      output_format: 'url',
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    const err = new Error(`MiniMax music error ${resp.status}: ${String(detail).slice(0, 300)}`);
    err.code = classifyMinimaxError(resp.status, detail);
    err.status = resp.status;
    throw err;
  }

  let payload;
  try {
    payload = await resp.json();
  } catch {
    const err = new Error('MiniMax returned a non-JSON response');
    err.code = 'API_ERROR';
    throw err;
  }
  const baseResp = payload && payload.base_resp;
  if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
    const err = new Error(`MiniMax music failed (${baseResp.status_code}): ${String(baseResp.status_msg || 'unknown error').slice(0, 200)}`);
    err.code = classifyMinimaxError(baseResp.status_code, baseResp.status_msg);
    throw err;
  }

  const audioUrl = payload.audio_url || (payload.data && payload.data.audio_url) || null;
  const inlineAudio = payload.audio || (payload.data && payload.data.audio) || null;

  let audioBuffer = null;
  if (audioUrl && /^https?:\/\//i.test(String(audioUrl))) {
    throwIfAborted(signal);
    const dl = await doFetch(String(audioUrl), {
      method: 'GET',
      signal: signalWithTimeout(signal, MINIMAX_TIMEOUT_MS),
    });
    if (!dl.ok) {
      const err = new Error(`MiniMax audio download failed (${dl.status})`);
      err.code = 'API_ERROR';
      err.status = dl.status;
      throw err;
    }
    audioBuffer = Buffer.from(await dl.arrayBuffer());
  } else if (inlineAudio) {
    audioBuffer = decodePossibleBinary(inlineAudio);
  }
  throwIfAborted(signal);
  if (!audioBuffer || audioBuffer.length === 0) {
    const err = new Error('MiniMax returned no audio');
    err.code = 'EMPTY_AUDIO';
    throw err;
  }

  ensureDir(audioDir);
  const filename = generatedMusicFilename('minimax');
  const audioPath = path.join(audioDir, filename);
  throwIfAborted(signal);
  fs.writeFileSync(audioPath, audioBuffer);

  return {
    filename,
    audioPath,
    audioUrl: `/api/elevenlabs/audio/${filename}`,
    sizeBytes: audioBuffer.length,
    mime: 'audio/mpeg',
    durationSeconds: seconds,
    model: resolvedModel,
    modelLabel: 'MiniMax',
    modelKey: 'minimax',
  };
}

module.exports = {
  generateMinimaxMusicFile,
  isMinimaxConfigured,
  clampSeconds,
  classifyMinimaxError,
  MINIMAX_MUSIC_MODEL,
  MINIMAX_API_BASE,
  audioDir,
};
