/**
 * suno-music
 *
 * Music generation through a Suno-compatible gateway implementing the
 * sunoapi.org contract:
 *   POST {base}/api/v1/generate {customMode, instrumental, model, prompt,
 *        style, title, styleWeight}
 *     → 200 { code:200, data:{ taskId } }
 *   GET  {base}/api/v1/generate/record-info?taskId={taskId}   (poll)
 *     → { code:200, data:{ status, response:{ sunoData:[{ audioUrl,
 *         duration, ... }] } } }
 *   status PENDING/TEXT_SUCCESS/FIRST_SUCCESS → keep polling;
 *   SUCCESS → download sunoData[0].audioUrl;
 *   CREATE_TASK_FAILED/GENERATE_AUDIO_FAILED/CALLBACK_EXCEPTION/
 *   SENSITIVE_WORD_ERROR → throw.
 *
 * HONESTY NOTE: Suno publishes NO official public API (verified 2026-09).
 * This module talks to a third-party Suno-compatible gateway and is fully
 * OPT-IN: without SUNO_API_KEY it throws SUNO_NOT_CONFIGURED and the
 * caller falls back to a configured provider, labelling the ACTUAL model.
 * Commercial use of gateway output is governed by Suno's own terms —
 * review them before enabling this in production.
 *
 * Mirrors `elevenlabs-music.js` (same audio dir + file naming + return
 * shape) so `/api/ai/generate-music` can pick it transparently.
 *
 * Env:
 *   SUNO_API_KEY          (required)  gateway key (Bearer)
 *   SUNO_API_BASE         (optional)  default https://api.sunoapi.org
 *   SUNO_V4_MODEL_ID      (optional)  default chirp-v4
 *   SUNO_V35_MODEL_ID     (optional)  default chirp-v3-5
 *   SUNO_CALLBACK_URL     (optional)  completion webhook; when absent the
 *                                     module polls record-info instead
 *   SUNO_TIMEOUT_MS       (optional)  overall budget, default 300000
 *   SUNO_POLL_MS          (optional)  poll interval, default 5000
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { signalWithTimeout, throwIfAborted } = require('../../utils/abort-signal');

const SUNO_API_BASE = (process.env.SUNO_API_BASE || 'https://api.sunoapi.org').replace(/\/+$/, '');
const SUNO_V4_MODEL = process.env.SUNO_V4_MODEL_ID || 'chirp-v4';
const SUNO_V35_MODEL = process.env.SUNO_V35_MODEL_ID || 'chirp-v3-5';
const SUNO_TIMEOUT_MS = Number(process.env.SUNO_TIMEOUT_MS) || 300000;
const SUNO_POLL_MS = Math.max(1000, Number(process.env.SUNO_POLL_MS) || 5000);

const TERMINAL_FAILURE = new Set([
  'CREATE_TASK_FAILED',
  'GENERATE_AUDIO_FAILED',
  'CALLBACK_EXCEPTION',
  'SENSITIVE_WORD_ERROR',
]);

const MIN_SECONDS = 5;
const MAX_SECONDS = 300;

const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve(__dirname, '../../../uploads');
const audioDir = path.join(uploadRoot, 'audio');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isSunoConfigured() {
  return Boolean(process.env.SUNO_API_KEY);
}

function generatedMusicFilename(prefix = 'suno', extension = 'mp3') {
  return `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}.${extension}`;
}

function clampSeconds(value, fallback = 30) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, n));
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function classifySunoError(status, detail) {
  const lower = String(detail || '').toLowerCase();
  if (status === 402 || /quota|insufficient|credit|balance|exceeds your/.test(lower)) return 'INSUFFICIENT_CREDITS';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 400 || /sensitive word/.test(lower)) return 'INVALID_PARAMS';
  return 'API_ERROR';
}

// Heuristic: explicit instrumental asks ("instrumental", "sin voz", …)
// render without AI vocals; everything else defaults to a full song.
function detectInstrumental(text) {
  return /(^|[\s,.;:¡!¿?()])instrumental([\s,.;:¡!¿?()]|$)|sin\s+voz|no\s+vocal|background|ambiente|ambient|lofi|lo-fi|study|focus|meditat/i
    .test(String(text || ''));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Generate a music track via the Suno gateway and persist it.
 *
 * @param {object} opts
 * @param {string} opts.prompt            required music description
 * @param {number} [opts.durationSeconds] metadata hint (gateway renders full songs)
 * @param {string} [opts.model]           gateway model id (default chirp-v4)
 * @param {string} [opts.style]           style hint for customMode (e.g. "Cinematic")
 * @param {string} [opts.mood]            mood hint folded into the style field
 * @param {number} [opts.influence]       0..1 prompt adherence → styleWeight
 * @param {boolean} [opts.instrumental]   force instrumental (default: auto-detect)
 * @param {Function} [opts.fetchImpl]     injectable fetch (tests)
 * @param {AbortSignal} [opts.signal]     user/request cancellation signal
 */
async function generateSunoMusicFile({
  prompt, durationSeconds, model, style, mood, influence, instrumental, fetchImpl, signal,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) {
    const err = new Error('Prompt is required for music generation');
    err.code = 'PROMPT_REQUIRED';
    throw err;
  }
  if (!isSunoConfigured()) {
    const err = new Error('Suno gateway API key not configured');
    err.code = 'SUNO_NOT_CONFIGURED';
    throw err;
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    const err = new Error('fetch is not available in this runtime');
    err.code = 'NO_FETCH';
    throw err;
  }

  const seconds = clampSeconds(durationSeconds, 30);
  const resolvedModel = String(model || '').trim() || SUNO_V4_MODEL;
  const styleParts = [
    String(style || '').trim(),
    String(mood || '').trim(),
  ].filter((part) => part && !/^(auto|balanced|none)$/i.test(part));
  const styleField = styleParts.length > 0 ? styleParts.join(', ') : 'Song';
  const useInstrumental = typeof instrumental === 'boolean' ? instrumental : detectInstrumental(cleanPrompt);
  const styleWeight = clamp01(influence, 0.3);
  throwIfAborted(signal);

  const submitBody = {
    customMode: true,
    instrumental: useInstrumental,
    model: resolvedModel,
    prompt: cleanPrompt.slice(0, 2000),
    style: styleField.slice(0, 200),
    title: cleanPrompt.slice(0, 80),
    styleWeight,
  };
  if (process.env.SUNO_CALLBACK_URL) submitBody.callBackUrl = process.env.SUNO_CALLBACK_URL;

  const submit = await doFetch(`${SUNO_API_BASE}/api/v1/generate`, {
    method: 'POST',
    signal: signalWithTimeout(signal, Math.min(SUNO_TIMEOUT_MS, 60000)),
    headers: {
      Authorization: `Bearer ${process.env.SUNO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });
  if (!submit.ok) {
    let detail = '';
    try { detail = await submit.text(); } catch { /* ignore */ }
    const err = new Error(`Suno gateway error ${submit.status}: ${String(detail).slice(0, 300)}`);
    err.code = classifySunoError(submit.status, detail);
    err.status = submit.status;
    throw err;
  }
  let submitted;
  try {
    submitted = await submit.json();
  } catch {
    const err = new Error('Suno gateway returned a non-JSON response');
    err.code = 'API_ERROR';
    throw err;
  }
  const taskId = submitted && submitted.data && submitted.data.taskId;
  if ((submitted && submitted.code !== 200) || !taskId) {
    const detail = (submitted && (submitted.msg || JSON.stringify(submitted).slice(0, 200))) || 'missing taskId';
    const err = new Error(`Suno gateway rejected the task: ${detail}`);
    err.code = classifySunoError(submitted && submitted.code, detail);
    throw err;
  }

  // Poll record-info until SUCCESS / terminal failure / timeout.
  const deadline = Date.now() + SUNO_TIMEOUT_MS;
  let audioUrl = null;
  let lastStatus = 'PENDING';
  for (;;) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      const err = new Error(`Suno task ${taskId} did not finish within ${Math.round(SUNO_TIMEOUT_MS / 1000)}s`);
      err.code = 'TIMEOUT';
      throw err;
    }
    await sleep(SUNO_POLL_MS, signal);
    throwIfAborted(signal);
    const poll = await doFetch(`${SUNO_API_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, {
      method: 'GET',
      signal: signalWithTimeout(signal, 30000),
      headers: { Authorization: `Bearer ${process.env.SUNO_API_KEY}` },
    });
    if (!poll.ok) {
      let detail = '';
      try { detail = await poll.text(); } catch { /* ignore */ }
      // A transient poll blip must not kill a minutes-long generation.
      if (poll.status >= 500) continue;
      const err = new Error(`Suno record-info error ${poll.status}: ${String(detail).slice(0, 200)}`);
      err.code = classifySunoError(poll.status, detail);
      err.status = poll.status;
      throw err;
    }
    let info;
    try {
      info = await poll.json();
    } catch { continue; }
    const data = (info && info.data) || {};
    lastStatus = data.status || lastStatus;
    if (TERMINAL_FAILURE.has(lastStatus)) {
      const msg = data.errorMessage || lastStatus;
      const err = new Error(lastStatus === 'SENSITIVE_WORD_ERROR'
        ? `Suno rechazó la letra por contenido sensible: ${String(msg).slice(0, 200)}`
        : `Suno task failed (${lastStatus}): ${String(msg).slice(0, 200)}`);
      err.code = lastStatus === 'SENSITIVE_WORD_ERROR' ? 'INVALID_PARAMS' : 'API_ERROR';
      throw err;
    }
    const tracks = data.response && Array.isArray(data.response.sunoData) ? data.response.sunoData : [];
    const ready = tracks.find((t) => t && /^https?:\/\//i.test(String(t.audioUrl || '')));
    if (lastStatus === 'SUCCESS' && ready) {
      audioUrl = String(ready.audioUrl);
      break;
    }
    if (ready && lastStatus !== 'SUCCESS') {
      // Stream URL available before final mastering — keep waiting for SUCCESS.
      continue;
    }
  }

  throwIfAborted(signal);
  const dl = await doFetch(audioUrl, {
    method: 'GET',
    signal: signalWithTimeout(signal, 120000),
  });
  if (!dl.ok) {
    const err = new Error(`Suno audio download failed (${dl.status})`);
    err.code = 'API_ERROR';
    err.status = dl.status;
    throw err;
  }
  const audioBuffer = Buffer.from(await dl.arrayBuffer());
  throwIfAborted(signal);
  if (!audioBuffer || audioBuffer.length === 0) {
    const err = new Error('Suno returned no audio');
    err.code = 'EMPTY_AUDIO';
    throw err;
  }

  ensureDir(audioDir);
  const filename = generatedMusicFilename('suno');
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
    modelLabel: resolvedModel === SUNO_V35_MODEL ? 'Suno V3.5' : 'Suno V4',
    modelKey: resolvedModel === SUNO_V35_MODEL ? 'sunoV35' : 'sunoV4',
    taskId,
  };
}

module.exports = {
  generateSunoMusicFile,
  isSunoConfigured,
  detectInstrumental,
  clampSeconds,
  classifySunoError,
  TERMINAL_FAILURE,
  SUNO_API_BASE,
  SUNO_V4_MODEL,
  SUNO_V35_MODEL,
  audioDir,
};
