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
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildUntrustedChildEnv } = require('../utils/untrusted-child-env');
const execFileAsync = promisify(execFile);
const localWhisper = require('./local-whisper-engine');
const voiceStudioClient = (options = {}) => options.voiceStudio || require('./ai/voicestudio-client');

const DEFAULT_AUDIO_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_MODEL = 'whisper-1';
const DEFAULT_LANGUAGE = 'es';

const AUDIO_MIME_MAP = {
  'audio/flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/x-flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/aac': { ext: 'aac', label: 'Audio AAC' },
  'audio/x-aac': { ext: 'aac', label: 'Audio AAC' },
  'audio/aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/x-aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/x-caf': { ext: 'caf', label: 'Audio CAF' },
  'audio/amr': { ext: 'amr', label: 'Audio AMR' },
  'audio/3gpp': { ext: '3gp', label: 'Audio 3GP' },
  'audio/x-ms-wma': { ext: 'wma', label: 'Audio WMA' },
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
  '.flac': 'audio/flac',
  '.mpga': 'audio/mpeg',
  '.mp2': 'audio/mpeg',
  '.wave': 'audio/wav',
  '.awb': 'audio/amr-wb',
  '.au': 'audio/basic',
  '.weba': 'audio/webm',
  '.m4b': 'audio/mp4',
  '.caf': 'audio/x-caf',
  '.aifc': 'audio/aiff',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.3g2': 'video/3gpp2',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.amr': 'audio/amr',
  '.3gp': 'audio/3gpp',
  '.wma': 'audio/x-ms-wma',
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
// xAI Grok STT (`/v1/stt`, see xai-audio.js), then Meta's transcription model
// (OpenAI-compatible `audio/transcriptions`), then the local whisper.cpp
// engine which has no size limit. An invalid key on one rung never blocks
// the next: every rung is tried in order.
const DEFAULT_PROVIDER_ORDER = ['openai', 'xai', 'meta', 'local'];
const DEFAULT_XAI_STT_MODEL = 'grok-stt';
const DEFAULT_META_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
const DEFAULT_META_BASE_URL = 'https://api.meta.ai/v1';
// Cloud providers cap request bodies (25 MB on Whisper). Longer recordings
// are re-encoded to mono 48 kbps MP3 and cut into 10-minute segments
// (≈3.6 MB each) that are transcribed in order and stitched back together.
const DEFAULT_SEGMENT_SECONDS = 600;
const SEGMENT_AUDIO_BITRATE = '48k';
const KEYISH_RE = /\bsk-[A-Za-z0-9._-]{3,}\b|\bBearer\s+\S+|OPENAI_API_KEY/i;

/** Clamp to a finite, non-negative millisecond timestamp. */
function clampTimestampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 3723.5 → "01:02:03,500" (SRT) or "01:02:03.500" (VTT). */
function formatTimestamp(seconds, separator) {
  const totalMs = Math.max(0, Math.round(clampTimestampSeconds(seconds) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mins = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}${separator}${String(ms).padStart(3, '0')}`;
}

function cleanSegmentText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

// Whisper can successfully decode silence/music while emitting only a
// non-speech annotation. It is not a spoken transcript and must not become
// evidence for a subsequent analysis. Keep annotations when speech ALSO
// exists; never discard a short real utterance such as "Sí" or "No".
function hasSpeechText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !/^(?:(?:\[|\()\s*(?:blank[_ ]audio|no[_ ]speech|silence|silent|silencio|m[uú]sica|music|inaudible|aplausos|applause|ruido|noise|sonido)\s*(?:\]|\))\s*[.,!]?\s*|<\|nospeech\|>\s*)+$/i.test(text);
}

/** Normalize raw provider segments: drop empties, fix inverted ranges. */
function normalizeSegments(segments) {
  const out = [];
  for (const raw of Array.isArray(segments) ? segments : []) {
    const text = cleanSegmentText(raw?.text);
    if (!text) continue;
    const start = clampTimestampSeconds(raw?.start);
    let end = clampTimestampSeconds(raw?.end);
    if (!(end > start)) end = start + 0.5;
    out.push({ start, end, text });
  }
  return out;
}

/** SubRip subtitles. Empty string when there are no usable segments. */
function buildSrt(segments) {
  const list = normalizeSegments(segments);
  return list.map((seg, index) => [
    String(index + 1),
    `${formatTimestamp(seg.start, ',')} --> ${formatTimestamp(seg.end, ',')}`,
    seg.text,
    '',
  ].join('\n')).join('\n').trim();
}

/** WebVTT subtitles. Empty string when there are no usable segments. */
function buildVtt(segments) {
  const list = normalizeSegments(segments);
  if (!list.length) return '';
  return ['WEBVTT', '', ...list.map((seg) => [
    `${formatTimestamp(seg.start, '.')} --> ${formatTimestamp(seg.end, '.')}`,
    seg.text,
    '',
  ].join('\n'))].join('\n').trim() + '\n';
}

/** Best-effort progress relay for long jobs; never breaks transcription. */
function emitProgress(options, event) {
  try {
    if (options && typeof options.onProgress === 'function') options.onProgress(event);
  } catch { /* progress is best-effort */ }
}

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
    ok: false,
    status: reasonCode === 'no_speech' ? 'no_speech' : 'failed',
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
    ok: true,
    status: 'ready',
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

function xaiApiKey(options = {}) {
  return String(envOf(options).XAI_API_KEY || '').trim();
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
    } else if (name === 'xai' && xaiApiKey(options) && String(env.TRANSCRIBE_XAI_DISABLED || '') !== '1') {
      out.push({
        name: 'xai',
        method: 'whisper',
        model: env.XAI_STT_MODEL || DEFAULT_XAI_STT_MODEL,
        verbose: false,
        // xAI STT is a multipart POST to /v1/stt, not the OpenAI SDK surface.
        transcribeFile: options.xaiTranscribe || ((filePath, mimeType, fileName, language) => require('./xai-audio').transcribeXaiAudioFile({
          filePath,
          originalName: fileName,
          mimeType,
          model: env.XAI_STT_MODEL || undefined,
          language,
          signal: options.signal,
          env,
        })),
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

function abortError() {
  return Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function mediaChildEnv() {
  return buildUntrustedChildEnv({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG });
}

function isAudioMedia(mimeType, fileName) {
  const mime = normalizeAudioMime(mimeType, fileName);
  return /^(audio|video)\//.test(mime) || mime === 'application/ogg';
}

function segmentDuration(options = {}) {
  const n = Number(options.segmentSeconds || envOf(options).TRANSCRIBE_SEGMENT_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.max(30, Math.min(DEFAULT_SEGMENT_SECONDS, n)) : DEFAULT_SEGMENT_SECONDS;
}

async function probeAudioDuration(filePath, options = {}) {
  throwIfAborted(options.signal);
  if (Number.isFinite(options.durationSeconds) && options.durationSeconds >= 0) return options.durationSeconds;
  if (typeof options.probeAudioDuration === 'function') return options.probeAudioDuration(filePath, options);
  const ffmpeg = options.ffmpegPath || envOf(options).FFMPEG_PATH;
  const probe = options.ffprobePath || (ffmpeg && path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), 'ffprobe') : 'ffprobe');
  try {
    const { stdout } = await execFileAsync(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], {
      timeout: 15_000, maxBuffer: 64 * 1024, signal: options.signal, env: mediaChildEnv(),
    });
    const duration = Number(String(stdout).trim());
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  } catch (err) {
    if (isAbortError(err, options.signal)) throw err;
    // A missing probe must not turn an otherwise supported short clip into a
    // failure. Byte-size segmentation and the provider/local decoder remain.
    return 0;
  }
}

// Cutting a 10-hour recording decodes every second of audio once; give the
// pass a budget that scales with the duration (6 min per audio hour, never
// under 10 min) instead of a flat ceiling that long lectures would hit.
function segmentationTimeoutMs(options = {}) {
  const explicit = Number(options.segmentTimeoutMs || envOf(options).TRANSCRIBE_SEGMENT_TIMEOUT_MS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const seconds = Number(options.durationSeconds) || 0;
  return Math.max(10 * 60 * 1000, Math.ceil(seconds * 100));
}

/**
 * Durable per-segment results. `options.checkpoint` ({ load, save }) lets the
 * caller persist each finished segment so a restart (deploy, crash, retry)
 * resumes a 10-hour transcription where it stopped instead of from zero.
 * Failures to read or write a checkpoint never fail the transcription.
 */
async function loadSegmentCheckpoint(options, index, meta) {
  if (!options.checkpoint || typeof options.checkpoint.load !== 'function') return null;
  try {
    const saved = await options.checkpoint.load(index, meta);
    return saved && typeof saved === 'object' ? saved : null;
  } catch { return null; }
}

async function saveSegmentCheckpoint(options, index, meta, part) {
  if (!options.checkpoint || typeof options.checkpoint.save !== 'function') return;
  try {
    await options.checkpoint.save(index, meta, {
      text: String(part?.text || part?.transcript || ''),
      segments: normalizeSegments(part?.segments),
      model: part?.model || null,
      language: part?.language || null,
    });
  } catch { /* a missing checkpoint only costs a re-run of this segment */ }
}

function progressEvent(options, stage, extra = {}) {
  emitProgress(options, { stage, durationSeconds: Number(options.durationSeconds) || 0, ...extra });
}

function runFfmpeg(args, options = {}) {
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  const bin = options.ffmpegPath || envOf(options).FFMPEG_PATH || 'ffmpeg';
  const limitMs = segmentationTimeoutMs(options);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(abortError());
    let child;
    let timer;
    let settled = false;
    let stderr = '';
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve();
    };
    const onAbort = () => {
      try { child?.kill('SIGKILL'); } catch (_) { /* already exited */ }
      finish(abortError());
    };
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, env: mediaChildEnv() });
    } catch (err) {
      finish(err);
      return;
    }
    child.stderr?.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : Object.assign(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'SEGMENT_FAILED' })));
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
      finish(Object.assign(new Error('ffmpeg segmentation timed out'), { code: 'SEGMENT_TIMEOUT' }));
    }, limitMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * Cut a long recording into cloud-sized pieces. Returns
 * { dir, segments: [{ path, index, offsetSeconds }] }. Injectable through
 * options.segmentAudio for tests.
 */
async function segmentForCloud(filePath, options = {}) {
  if (typeof options.segmentAudio === 'function') return options.segmentAudio(filePath, options);
  const seconds = segmentDuration(options);
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-transcribe-seg-'));
  const pattern = path.join(dir, 'seg-%04d.mp3');
  try {
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
  } catch (err) {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt) {
  if (typeof provider.transcribeFile === 'function') {
    const out = await provider.transcribeFile(filePath, mimeType, fileName, language, prompt);
    return {
      text: String(out?.text || ''),
      segments: [],
      model: out?.model || provider.model,
      language: language || out?.language || null,
    };
  }
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
  const requestOptions = { timeout: 120_000, maxRetries: 2, ...(options.signal ? { signal: options.signal } : {}) };
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
  if (fileSize <= maxBytes && !(options.durationSeconds > segmentDuration(options))) {
    return transcribeCloudFile(provider, filePath, mimeType, fileName, options, language, prompt);
  }
  progressEvent(options, 'preparing');
  const { dir, segments } = await segmentForCloud(filePath, options);
  try {
    const texts = [];
    const stitched = [];
    const meta = { segmentSeconds: segmentDuration(options), total: segments.length };
    progressEvent(options, 'segments', { completed: 0, total: segments.length });
    for (const seg of segments) {
      if (options.signal && options.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      let part = await loadSegmentCheckpoint(options, seg.index, meta);
      if (!part) {
        part = await transcribeCloudFile(provider, seg.path, 'audio/mpeg', `segment-${seg.index + 1}.mp3`, options, language, prompt);
        await saveSegmentCheckpoint(options, seg.index, meta, part);
      }
      progressEvent(options, 'transcribe', { completed: seg.index + 1, total: segments.length });
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
  const requestOptions = { timeout: 120_000, maxRetries: 2, ...(options.signal ? { signal: options.signal } : {}) };
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
  const localOptions = { ...options, language, prompt };
  if (!(options.durationSeconds > segmentDuration(options))) return impl(filePath, localOptions);
  progressEvent(options, 'preparing');
  const { dir, segments } = await segmentForCloud(filePath, options);
  try {
    const texts = [];
    const stitched = [];
    let metadata = {};
    const meta = { segmentSeconds: segmentDuration(options), total: segments.length };
    progressEvent(options, 'segments', { completed: 0, total: segments.length });
    for (const seg of segments) {
      throwIfAborted(options.signal);
      let part = await loadSegmentCheckpoint(options, seg.index, meta);
      if (!part) {
        part = await impl(seg.path, localOptions);
        await saveSegmentCheckpoint(options, seg.index, meta, part);
      }
      metadata = part || {};
      const text = String(part?.text || part?.transcript || '').trim();
      if (text) texts.push(text);
      for (const item of normalizeSegments(part?.segments)) {
        stitched.push({ ...item, start: item.start + seg.offsetSeconds, end: item.end + seg.offsetSeconds });
      }
      progressEvent(options, 'transcribe', { completed: seg.index + 1, total: segments.length });
    }
    return { ...metadata, text: texts.join('\n\n'), segments: stitched };
  } finally {
    if (dir) await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribe an audio or video file.
 * Returns { text, method: 'local-whisper' | 'whisper' | 'placeholder' }
 */
async function transcribeUnqueued(filePath, mimeType, originalName, options = {}) {
  throwIfAborted(options.signal);
  options = { ...options, durationSeconds: await probeAudioDuration(filePath, options) };
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
    return placeholderResult(fileName, label, normalizedMime, 'file_unavailable');
  }
  if (!fileSize) return placeholderResult(fileName, label, normalizedMime, 'file_empty');

  // Cloud ladder (OpenAI → Meta). Files above the provider cap are segmented,
  // never rejected: a 500 MB lecture video is exactly the use case.
  for (const provider of cloudProviders(options)) {
    try {
      const cloud = await transcribeCloud(provider, filePath, normalizedMime, fileName, fileSize, maxBytes, options, language, prompt);
      const text = String(cloud.text || '').trim();
      if (!hasSpeechText(text)) {
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

  // Opt-in: Sira Voz / VoiceStudio (WhisperX large-v3, on this host). List
  // 'voicestudio' in TRANSCRIBE_PROVIDERS to use it before the bundled
  // whisper.cpp base model — better accuracy, slower on CPU, still free.
  if (providerOrder(options).includes('voicestudio')) {
    const vsClient = voiceStudioClient(options);
    if (vsClient.isConfigured(options)) {
      try {
        const vs = await vsClient.transcribe({ filePath, filename: fileName, mime: normalizedMime, language, prompt, signal: options.signal }, options);
        const text = String(vs?.text || '').trim();
        if (hasSpeechText(text)) {
          return formatSuccess({
            text,
            method: 'local-whisper',
            model: 'voicestudio-whisperx',
            language: vs.language || language || null,
            segments: vs.segments,
          });
        }
        logSafe('VoiceStudio transcription returned no speech; trying the next provider');
      } catch (err) {
        if (isAbortError(err, options.signal)) throw err;
        logSafe(`VoiceStudio transcription failed (${sanitizeProviderError(err)}); trying the next provider`);
      }
    }
  }

  if (!localEnabled(options)) {
    return placeholderResult(fileName, label, normalizedMime, 'local_unavailable');
  }

  try {
    const local = await transcribeLocalPath(filePath, options, language, prompt);
    const text = String(local?.text || local?.transcript || '').trim();
    if (!hasSpeechText(text)) {
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
    return placeholderResult(fileName, label, normalizedMime, err?.code === 'AUDIO_DECODE_FAILED' ? 'audio_decode_failed' : 'local_unavailable');
  }
}

// Shared admission control also covers uploads and agent-task recovery calls.
// Do not fan out fifty whisper processes (or fifty paid requests) at once.
const TRANSCRIPTION_CONCURRENCY = 2;
let activeTranscriptions = 0;
const transcriptionQueue = [];
const inFlight = new Map();
const identityIds = new WeakMap();
let nextIdentityId = 1;
function identity(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return String(value || '');
  if (!identityIds.has(value)) identityIds.set(value, nextIdentityId++);
  return identityIds.get(value);
}

function drainTranscriptions() {
  while (activeTranscriptions < TRANSCRIPTION_CONCURRENCY && transcriptionQueue.length) {
    const job = transcriptionQueue.shift();
    job.signal.removeEventListener('abort', job.onAbort);
    if (job.signal.aborted) { job.reject(abortError()); continue; }
    activeTranscriptions++;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      activeTranscriptions--;
      drainTranscriptions();
    });
  }
}

function enqueueTranscription(run, signal) {
  return new Promise((resolve, reject) => {
    const job = { run, signal, resolve, reject };
    job.onAbort = () => {
      const index = transcriptionQueue.indexOf(job);
      if (index >= 0) transcriptionQueue.splice(index, 1);
      reject(abortError());
    };
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', job.onAbort, { once: true });
    transcriptionQueue.push(job);
    drainTranscriptions();
  });
}

async function transcribe(filePath, mimeType, originalName, options = {}) {
  throwIfAborted(options.signal);
  // Explicitly cancellable jobs own their signal and durable claim. Do not
  // couple independently cancelled jobs through single-flight; unsignalled
  // legacy upload calls still share work below.
  if (options.signal) return enqueueTranscription(() => transcribeUnqueued(filePath, mimeType, originalName, options), options.signal);
  const stat = await fsPromises.stat(filePath).catch(() => null);
  throwIfAborted(options.signal);
  // Include configuration identity as well as file revision. Never share a
  // result across explicitly different injected clients/settings. No permanent
  // cache: persistence and access checks are owned by the File/job layer.
  const key = JSON.stringify([path.resolve(filePath), stat?.size, stat?.mtimeMs,
    normalizeAudioMime(mimeType, originalName), originalName, resolveLanguage(options), options.prompt || envOf(options).WHISPER_PROMPT,
    providerOrder(options), options.model, options.maxFileBytes, options.durationSeconds, options.segmentSeconds,
    options.ffmpegPath, options.ffprobePath, options.whisperBin, options.modelPath, options.pythonPath, options.threads, options.timeoutMs,
    ...['env', 'openai', 'metaClient', 'localTranscribe', 'xaiTranscribe', 'voiceStudio', 'segmentAudio', 'probeAudioDuration', 'spawnImpl', 'createFile'].map((k) => identity(options[k])),
  ]);
  let entry = inFlight.get(key);
  if (entry?.controller.signal.aborted) entry = null;
  if (!entry) {
    entry = { controller: new AbortController(), subscribers: new Set() };
    inFlight.set(key, entry);
    const current = entry;
    entry.promise = enqueueTranscription(() => transcribeUnqueued(filePath, mimeType, originalName, {
      ...options, signal: current.controller.signal,
      onProgress: (event) => { for (const subscriber of current.subscribers) emitProgress(subscriber.options, event); },
    }), entry.controller.signal);
    const cleanup = () => { if (inFlight.get(key) === current) inFlight.delete(key); };
    entry.promise.then(cleanup, cleanup);
  }
  const subscriber = { options };
  entry.subscribers.add(subscriber);
  try {
    return await entry.promise;
  } finally {
    entry.subscribers.delete(subscriber);
  }
}

module.exports = {
  isAudioMedia,
  probeAudioDuration,
  TRANSCRIPTION_CONCURRENCY,
  cloudProviders,
  providerOrder,
  segmentForCloud,
  segmentationTimeoutMs,
  transcribeCloud,
  buildSrt,
  buildVtt,
  formatTimestamp,
  normalizeSegments,
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
  xaiApiKey,
  DEFAULT_XAI_STT_MODEL,
  AUDIO_MIME_MAP,
  SUCCESS_METHODS,
  get AUDIO_MAX_FILE_BYTES() {
    return audioMaxFileBytes();
  },
};
