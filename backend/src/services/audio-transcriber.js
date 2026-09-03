'use strict';

/**
 * Audio transcriber — speech-to-text for audio/video, including WhatsApp
 * PTT (ogg/opus/m4a).
 *
 * Ladder:
 *   1. OpenAI Whisper — optional faster path when a key is present AND the
 *      request succeeds.
 *   2. Local Whisper (whisper.cpp or faster-whisper) — no API key.
 *   3. Sanitized Spanish placeholder — never includes provider error text
 *      or API keys.
 *
 * Config:
 *   WHISPER_MODEL = whisper-1 (OpenAI only)
 *   WHISPER_LANGUAGE = es when unset (Peru/Spanish WhatsApp notes)
 *   WHISPER_PROMPT = optional guiding prompt
 *   AUDIO_MAX_FILE_BYTES = 25 MB
 *   WHISPER_CPP_BIN / WHISPER_CPP_MODEL / LOCAL_WHISPER_MODEL
 */

const fsPromises = require('fs').promises;
const path = require('path');
const { redactString } = require('../utils/secret-redactor');
const os = require('os');
const localWhisper = require('./local-whisper-engine');

const DEFAULT_AUDIO_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_MODEL = 'whisper-1';
const DEFAULT_LANGUAGE = 'es';

const AUDIO_MIME_MAP = {
  'audio/mpeg': { ext: 'mp3', label: 'Audio MP3' },
  'audio/mp3': { ext: 'mp3', label: 'Audio MP3' },
  'audio/wav': { ext: 'wav', label: 'Audio WAV' },
  'audio/x-wav': { ext: 'wav', label: 'Audio WAV' },
  'audio/ogg': { ext: 'ogg', label: 'Audio OGG' },
  'audio/opus': { ext: 'opus', label: 'Audio Opus' },
  'application/ogg': { ext: 'ogg', label: 'Audio OGG' },
  'audio/webm': { ext: 'webm', label: 'Audio WebM' },
  'audio/mp4': { ext: 'm4a', label: 'Audio M4A' },
  'audio/m4a': { ext: 'm4a', label: 'Audio M4A' },
  'audio/x-m4a': { ext: 'm4a', label: 'Audio M4A' },
  'video/mp4': { ext: 'mp4', label: 'Video MP4' },
  'video/mpeg': { ext: 'mpeg', label: 'Video MPEG' },
  'video/quicktime': { ext: 'mov', label: 'Video QuickTime' },
  'video/webm': { ext: 'webm', label: 'Video WebM' },
};

const EXT_MIME_FALLBACK = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'audio/webm',
};

const SUCCESS_METHODS = new Set(['whisper', 'local-whisper']);
// Cloud transcription ladder. OpenAI Whisper first when its key works, then
// Meta's transcription model (same OpenAI-compatible `audio/transcriptions`
// surface), then the local whisper.cpp engine which has no size limit.
const DEFAULT_PROVIDER_ORDER = ['openai', 'meta', 'local'];
const DEFAULT_META_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
const DEFAULT_META_BASE_URL = 'https://api.meta.ai/v1';
// Cloud providers cap request bodies (25 MB on Whisper). Longer recordings
// are re-encoded to mono 48 kbps MP3 and cut into 10-minute segments
// (≈3.6 MB each) that are transcribed in order and stitched back together.
const DEFAULT_SEGMENT_SECONDS = 600;
const SEGMENT_AUDIO_BITRATE = '48k';
const KEYISH_RE = /\bsk-[A-Za-z0-9._-]{3,}\b|\bBearer\s+\S+|OPENAI_API_KEY/i;

function envOf(options = {}) {
  return options.env || process.env;
}

function audioMaxFileBytes(options = {}) {
  const raw = Number.parseInt(
    options.maxFileBytes || envOf(options).AUDIO_MAX_FILE_BYTES || '',
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIO_MAX_FILE_BYTES;
}

function normalizeAudioMime(mimeType, fileName) {
  const declared = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (AUDIO_MIME_MAP[declared]) return declared;
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return EXT_MIME_FALLBACK[ext] || declared;
}

function mimeInfo(mimeType, fileName) {
  const normalized = normalizeAudioMime(mimeType, fileName);
  return AUDIO_MIME_MAP[normalized] || { ext: 'bin', label: 'Archivo de audio' };
}

function resolveLanguage(options = {}) {
  if (typeof options.language === 'string' && options.language.trim()) {
    return options.language.trim();
  }
  const env = envOf(options);
  if (Object.prototype.hasOwnProperty.call(env, 'WHISPER_LANGUAGE')) {
    const value = String(env.WHISPER_LANGUAGE || '').trim();
    return value || undefined;
  }
  return DEFAULT_LANGUAGE;
}

function hasOpenAiKey(options = {}) {
  if (options.openai) return true;
  return Boolean(String(envOf(options).OPENAI_API_KEY || '').trim());
}

function isAbortError(err, signal) {
  if (signal?.aborted) return true;
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  return name === 'AbortError'
    || code === 'ABORT_ERR'
    || code === 'LOCAL_WHISPER_ABORTED'
    || /abort(ed)? by user|aborted|The operation was aborted/i.test(message);
}

function isInvalidKeyError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  const code = String(err?.code || err?.error?.code || '');
  const message = String(err?.message || err?.error?.message || '');
  return status === 401
    || status === 403
    || code === 'invalid_api_key'
    || /invalid_api_key|incorrect api key|invalid api key/i.test(message);
}

function sanitizeProviderError(err) {
  const raw = String(err?.message || err || '');
  const redacted = redactString(raw);
  if (KEYISH_RE.test(raw) || KEYISH_RE.test(redacted) || isInvalidKeyError(err)) {
    return 'error de proveedor';
  }
  return redacted.slice(0, 180);
}

function generatePlaceholder(fileName, label, mimeType, reasonCode) {
  const publicReason = reasonCode === 'file_too_large'
    ? 'El archivo supera el tamaño máximo.'
    : reasonCode === 'no_speech'
      ? 'No se detectó voz.'
      : 'Transcripción no disponible.';
  return [
    `${label} — ${fileName}`,
    `Tipo: ${mimeType || 'desconocido'}`,
    `Estado: ${publicReason}`,
  ].join('\n');
}

function placeholderResult(fileName, label, mimeType, reasonCode) {
  return {
    text: generatePlaceholder(fileName, label, mimeType, reasonCode),
    method: 'placeholder',
    reasonCode,
  };
}

function formatSuccess({ text, method, model, language, segments }) {
  const transcript = String(text || '').trim();
  const header = `${method === 'local-whisper' ? 'Transcripción local' : 'Transcripción'} — ${transcript.length} caracteres` +
    (model ? `, modelo: ${model}` : '') +
    (language ? `, idioma: ${language}` : '') +
    '\n---\n';
  return {
    text: header + transcript,
    transcript,
    method,
    model: model || null,
    language: language || null,
    segments: Array.isArray(segments) ? segments : [],
  };
}

function logSafe(message) {
  console.warn(`[audio-transcriber] ${redactString(String(message || ''))}`);
}

function providerOrder(options = {}) {
  const raw = options.providers || envOf(options).TRANSCRIBE_PROVIDERS;
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(',') : DEFAULT_PROVIDER_ORDER);
  const cleaned = list.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_PROVIDER_ORDER;
}

function metaApiKey(options = {}) {
  const env = envOf(options);
  return String(env.MODEL_API_KEY || env.META_API_KEY || env.LLAMA_API_KEY || '').trim();
}

/** Cloud providers in ladder order, only those with a usable key. */
function cloudProviders(options = {}) {
  const env = envOf(options);
  const out = [];
  for (const name of providerOrder(options)) {
    if (name === 'openai' && hasOpenAiKey(options)) {
      out.push({
        name: 'openai',
        method: 'whisper',
        model: options.model || env.WHISPER_MODEL || DEFAULT_OPENAI_MODEL,
        verbose: true,
        client: () => options.openai || (() => {
          const OpenAI = require('openai');
          return new OpenAI({ apiKey: env.OPENAI_API_KEY });
        })(),
      });
    } else if (name === 'meta' && metaApiKey(options) && String(env.TRANSCRIBE_META_DISABLED || '') !== '1') {
      out.push({
        name: 'meta',
        method: 'whisper',
        model: env.META_TRANSCRIBE_MODEL || DEFAULT_META_TRANSCRIBE_MODEL,
        verbose: false,
        client: () => options.metaClient || (() => {
          const OpenAI = require('openai');
          return new OpenAI({ apiKey: metaApiKey(options), baseURL: env.META_BASE_URL || DEFAULT_META_BASE_URL });
        })(),
      });
    }
  }
  return out;
}

function localEnabled(options = {}) {
  return providerOrder(options).includes('local');
}

function runFfmpeg(args, options = {}) {
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  const bin = options.ffmpegPath || envOf(options).FFMPEG_PATH || 'ffmpeg';
  const limitMs = Number(options.segmentTimeoutMs || envOf(options).TRANSCRIBE_SEGMENT_TIMEOUT_MS) || 10 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      reject(Object.assign(new Error('ffmpeg segmentation timed out'), { code: 'SEGMENT_TIMEOUT' }));
    }, limitMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'SEGMENT_FAILED' }));
    });
  });
}

/**
 * Cut a long recording into cloud-sized pieces. Returns
 * { dir, segments: [{ path, index, offsetSeconds }] }. Injectable through
 * options.segmentAudio for tests.
 */
async function segmentForCloud(filePath, options = {}) {
  if (typeof options.segmentAudio === 'function') return options.segmentAudio(filePath, options);
  const seconds = Number(options.segmentSeconds || envOf(options).TRANSCRIBE_SEGMENT_SECONDS) || DEFAULT_SEGMENT_SECONDS;
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-seg-'));
  const pattern = path.join(dir, 'seg-%04d.mp3');
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', filePath,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-b:a', SEGMENT_AUDIO_BITRATE,
    '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1',
    pattern,
  ], options);
  const names = (await fsPromises.readdir(dir)).filter((n) => /^seg-\d+\.mp3$/.test(n)).sort();
  if (!names.length) throw Object.assign(new Error('ffmpeg produced no segments'), { code: 'SEGMENT_EMPTY' });
  return {
    dir,
    segments: names.map((name, index) => ({ path: path.join(dir, name), index, offsetSeconds: index * seconds })),
  };
}

async function transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt) {
  const client = provider.client();
  const fileBuffer = await fsPromises.readFile(filePath);
  const blob = typeof options.createFile === 'function'
    ? options.createFile(fileBuffer, fileName, mimeType || 'audio/mpeg')
    : new File([fileBuffer], fileName, { type: mimeType || 'audio/mpeg' });
  const request = { model: provider.model, file: blob };
  if (provider.verbose) {
    request.response_format = 'verbose_json';
    request.timestamp_granularities = ['segment'];
  } else {
    request.response_format = 'json';
  }
  if (language) request.language = language;
  if (prompt) request.prompt = prompt;
  const requestOptions = options.signal ? { signal: options.signal } : undefined;
  const transcription = await client.audio.transcriptions.create(request, requestOptions);
  const text = typeof transcription === 'string' ? transcription : (transcription.text || '');
  return {
    text,
    segments: (transcription && Array.isArray(transcription.segments) ? transcription.segments : []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    })),
    model: provider.model,
    language: language || (transcription && transcription.language) || null,
  };
}

/** Whole file when it fits the provider cap; otherwise segment → transcribe → stitch. */
async function transcribeCloud(provider, filePath, mimeType, fileName, fileSize, maxBytes, options, language, prompt) {
  if (fileSize <= maxBytes) {
    return transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt);
  }
  const { dir, segments } = await segmentForCloud(filePath, options);
  try {
    const texts = [];
    const stitched = [];
    for (const seg of segments) {
      if (options.signal && options.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const part = await transcribeCloudFile(provider, seg.path, 'audio/mpeg', `segment-${seg.index + 1}.mp3`, options, language, prompt);
      const text = String(part.text || '').trim();
      if (text) texts.push(text);
      for (const s of part.segments || []) {
        stitched.push({ start: (s.start || 0) + seg.offsetSeconds, end: (s.end || 0) + seg.offsetSeconds, text: s.text });
      }
    }
    return { text: texts.join('\n\n'), segments: stitched, model: provider.model, language: language || null, segmentCount: segments.length };
  } finally {
    if (dir) await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeOpenAi(filePath, mimeType, fileName, options, language, prompt, model) {
  const openai = options.openai || (() => {
    const OpenAI = require('openai');
    return new OpenAI({ apiKey: envOf(options).OPENAI_API_KEY });
  })();

  const fileBuffer = await fsPromises.readFile(filePath);
  const blob = typeof options.createFile === 'function'
    ? options.createFile(fileBuffer, fileName, mimeType || 'audio/mpeg')
    : new File([fileBuffer], fileName, { type: mimeType || 'audio/mpeg' });

  const request = {
    model,
    file: blob,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  };
  if (language) request.language = language;
  if (prompt) request.prompt = prompt;
  const requestOptions = options.signal ? { signal: options.signal } : undefined;
  const transcription = await openai.audio.transcriptions.create(request, requestOptions);
  return {
    text: transcription.text || '',
    segments: transcription.segments?.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    })) || [],
    model,
    language: language || null,
  };
}

async function transcribeLocalPath(filePath, options, language, prompt) {
  const impl = options.localTranscribe || localWhisper.transcribeLocal;
  return impl(filePath, {
    ...options,
    language,
    prompt,
  });
}

/**
 * Transcribe an audio or video file.
 * Returns { text, method: 'local-whisper' | 'whisper' | 'placeholder' }
 */
async function transcribe(filePath, mimeType, originalName, options = {}) {
  const fileName = originalName || path.basename(filePath);
  const normalizedMime = normalizeAudioMime(mimeType, fileName);
  const info = mimeInfo(normalizedMime, fileName);
  const label = info.label;
  const language = resolveLanguage(options);
  const prompt = typeof options.prompt === 'string' && options.prompt.trim()
    ? options.prompt.trim().slice(0, 1000)
    : envOf(options).WHISPER_PROMPT || undefined;
  const model = options.model || envOf(options).WHISPER_MODEL || DEFAULT_OPENAI_MODEL;
  const maxBytes = audioMaxFileBytes(options);

  let fileSize = 0;
  try {
    fileSize = (await fsPromises.stat(filePath)).size;
  } catch {
    fileSize = 0;
  }

  // Cloud ladder (OpenAI → Meta). Files above the provider cap are segmented,
  // never rejected: a 500 MB lecture video is exactly the use case.
  for (const provider of cloudProviders(options)) {
    try {
      const cloud = await transcribeCloud(provider, filePath, normalizedMime, fileName, fileSize, maxBytes, options, language, prompt);
      const text = String(cloud.text || '').trim();
      if (text.length < 10) {
        return placeholderResult(fileName, label, normalizedMime, 'no_speech');
      }
      return formatSuccess({
        text,
        method: 'whisper',
        model: cloud.model,
        language: cloud.language,
        segments: cloud.segments,
      });
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      const safe = sanitizeProviderError(err);
      if (isInvalidKeyError(err)) {
        logSafe(`${provider.name} transcription rejected the key (${safe}); trying the next provider`);
      } else {
        logSafe(`${provider.name} transcription failed (${safe}); trying the next provider`);
      }
    }
  }

  if (!localEnabled(options)) {
    return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
  }

  try {
    const local = await transcribeLocalPath(filePath, options, language, prompt);
    const text = String(local?.text || local?.transcript || '').trim();
    if (!text || text.length < 3) {
      return placeholderResult(fileName, label, normalizedMime, 'no_speech');
    }
    return formatSuccess({
      text,
      method: 'local-whisper',
      model: local.model || 'base',
      language: local.language || language || null,
      segments: local.segments,
    });
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    logSafe(`Local Whisper failed: ${sanitizeProviderError(err)}`);
    return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
  }
}

module.exports = {
  cloudProviders,
  providerOrder,
  segmentForCloud,
  transcribeCloud,
  DEFAULT_META_TRANSCRIBE_MODEL,
  DEFAULT_SEGMENT_SECONDS,
  transcribe,
  generatePlaceholder,
  sanitizeProviderError,
  normalizeAudioMime,
  resolveLanguage,
  isAbortError,
  isInvalidKeyError,
  hasOpenAiKey,
  AUDIO_MIME_MAP,
  SUCCESS_METHODS,
  get AUDIO_MAX_FILE_BYTES() {
    return audioMaxFileBytes();
  },
};
