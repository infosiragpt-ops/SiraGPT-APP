/**
 * lyria-music
 *
 * Music generation via Google Lyria 3 Pro on OpenRouter
 * (`google/lyria-3-pro-preview`). Mirrors `elevenlabs-music.js` (same audio
 * dir + file naming + return shape) so the `/api/ai/generate-music` route can
 * pick a provider transparently and the chat renders the same "Generation N"
 * artifact.
 *
 * Contract (verified against OpenRouter): audio output REQUIRES streaming.
 * POST /chat/completions with modalities:["text","audio"], audio:{format:"mp3"}
 * and stream:true; the MP3 arrives as base64 in `choices[].delta.audio.data`
 * across SSE chunks — concatenate and base64-decode to the final file.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout, throwIfAborted } = require('../../utils/abort-signal');

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const LYRIA_MODEL = process.env.LYRIA_MODEL_ID || 'google/lyria-3-pro-preview';
const LYRIA_TIMEOUT_MS = Number(process.env.LYRIA_TIMEOUT_MS) || 240000;

const MIN_SECONDS = 5;
const MAX_SECONDS = 300;

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isLyriaConfigured() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function generatedMusicFilename(prefix = 'lyria', extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

function clampSeconds(value, fallback = 30) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

function classifyOpenRouterError(status, detail) {
  const lower = String(detail || '').toLowerCase();
  if (status === 402 || /quota|insufficient|credit|exceeds your/.test(lower)) return 'INSUFFICIENT_CREDITS';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'INVALID_PARAMS';
  return 'API_ERROR';
}

/**
 * Generate a music track via Lyria 3 Pro (OpenRouter) and persist it to the
 * served audio directory.
 *
 * @param {object} opts
 * @param {string} opts.prompt            required music description
 * @param {number} [opts.durationSeconds] target length hint in seconds
 * @param {Function} [opts.fetchImpl]     injectable fetch (tests)
 * @param {AbortSignal} [opts.signal]     user/request cancellation signal
 * @returns {Promise<{filename,audioPath,audioUrl,sizeBytes,mime,durationSeconds,model}>}
 */
async function generateLyriaMusicFile({ prompt, durationSeconds, fetchImpl, signal } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    const err = new Error('Prompt is required for music generation');
    err.code = 'PROMPT_REQUIRED';
    throw err;
  }
  if (!isLyriaConfigured()) {
    const err = new Error('OpenRouter API key not configured');
    err.code = 'OPENROUTER_NOT_CONFIGURED';
    throw err;
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    const err = new Error('fetch is not available in this runtime');
    err.code = 'NO_FETCH';
    throw err;
  }

  const seconds = clampSeconds(durationSeconds, 30);
  const fullPrompt = `${cleanPrompt}\n\nDuración aproximada de la pista: ${seconds} segundos.`;
  throwIfAborted(signal);

  const resp = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    signal: signalWithTimeout(signal, LYRIA_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://siragpt.com',
      'X-Title': 'SiraGPT',
    },
    body: JSON.stringify({
      model: LYRIA_MODEL,
      messages: [{ role: 'user', content: fullPrompt }],
      modalities: ['text', 'audio'],
      audio: { format: 'mp3' },
      stream: true,
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    const err = new Error(`Lyria/OpenRouter error ${resp.status}: ${String(detail).slice(0, 300)}`);
    err.code = classifyOpenRouterError(resp.status, detail);
    err.status = resp.status;
    throw err;
  }
  if (!resp.body) {
    const err = new Error('Lyria stream body missing');
    err.code = 'API_ERROR';
    throw err;
  }

  // Parse the SSE stream: accumulate every choices[].delta.audio.data fragment.
  const audioParts = [];
  let streamError = null;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of resp.body) {
    throwIfAborted(signal);
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // skip ": OPENROUTER PROCESSING" heartbeats
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.error) { streamError = evt.error; continue; }
      for (const ch of evt.choices || []) {
        const data = ch.delta && ch.delta.audio && ch.delta.audio.data;
        if (data) audioParts.push(data);
      }
    }
  }

  throwIfAborted(signal);
  if (streamError && audioParts.length === 0) {
    const detail = typeof streamError === 'object' ? JSON.stringify(streamError) : String(streamError);
    const err = new Error(`Lyria stream error: ${detail.slice(0, 300)}`);
    err.code = classifyOpenRouterError(streamError && streamError.code, detail);
    throw err;
  }

  const audioBuffer = Buffer.from(audioParts.join(''), 'base64');
  if (!audioBuffer || audioBuffer.length === 0) {
    const err = new Error('Lyria returned no audio');
    err.code = 'EMPTY_AUDIO';
    throw err;
  }

  ensureDir(audioDir);
  const filename = generatedMusicFilename('lyria');
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
    model: LYRIA_MODEL,
  };
}

module.exports = {
  generateLyriaMusicFile,
  isLyriaConfigured,
  clampSeconds,
  classifyOpenRouterError,
  LYRIA_MODEL,
  audioDir,
};
