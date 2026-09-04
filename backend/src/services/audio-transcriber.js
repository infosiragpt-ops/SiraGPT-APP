'use strict';

/**
 * Audio transcriber — speech-to-text for audio/video, including WhatsApp
 * PTT (ogg/opus/m4a).
 *
 * Ladder:
 *   1. OpenAI Whisper — optional faster path when a key is present AND the
 *      request succeeds.
 *   2. Meta transcription model (same OpenAI-compatible surface) — key-gated.
 *   3. Local STT over HTTP, VoiceStudio-inspired (OPT-IN) — any
 *      OpenAI-compatible `POST /v1/audio/transcriptions` endpoint
 *      (VoiceStudio :3900, faster-whisper-server, whisper.cpp server…).
 *      Enable with `TRANSCRIBE_PROVIDERS=local-stt,...` or
 *      `SIRAGPT_LOCAL_STT_ENABLED=1`. Concept only, no VoiceStudio code.
 *      100% local: `TRANSCRIBE_PROVIDERS=local-stt,local`.
 *   4. Local Whisper (whisper.cpp or faster-whisper) — no API key.
 *   5. Sanitized Spanish placeholder — never includes provider error text
 *      or API keys.
 *
 * Professional outputs (additive, backward compatible): every success also
 * carries `srt`/`vtt` subtitles generated locally, `words`, `speakers`,
 * `speakerCount`, `diarized`, `durationMs` and `provider`.
 *
 * Config:
 *   WHISPER_MODEL = whisper-1 (OpenAI only)
 *   WHISPER_LANGUAGE = es when unset (Peru/Spanish WhatsApp notes)
 *   WHISPER_PROMPT = optional guiding prompt
 *   AUDIO_MAX_FILE_BYTES = 25 MB
 *   WHISPER_CPP_BIN / WHISPER_CPP_MODEL / LOCAL_WHISPER_MODEL
 *   TRANSCRIBE_PROVIDERS = openai,meta,local (add local-stt to opt in)
 *   SIRAGPT_LOCAL_STT_ENABLED=1 — try the HTTP rung before the binary engine
 *   SIRAGPT_LOCAL_STT_URL/_TIMEOUT_MS/_MODEL — see voice-studio-local-stt.js
 */

const fsPromises = require('fs').promises;
const path = require('path');
const { redactString } = require('../utils/secret-redactor');
const os = require('os');
const localStt = require('./voice-studio-local-stt');

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
  'audio/flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/x-flac': { ext: 'flac', label: 'Audio FLAC' },
  'audio/aac': { ext: 'aac', label: 'Audio AAC' },
  'audio/aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/x-aiff': { ext: 'aiff', label: 'Audio AIFF' },
  'audio/amr': { ext: 'amr', label: 'Audio AMR' },
  'audio/3gpp': { ext: '3gp', label: 'Audio 3GP' },
  'audio/x-ms-wma': { ext: 'wma', label: 'Audio WMA' },
  'video/mp4': { ext: 'mp4', label: 'Video MP4' },
  'video/mpeg': { ext: 'mpeg', label: 'Video MPEG' },
  'video/quicktime': { ext: 'mov', label: 'Video QuickTime' },
  'video/webm': { ext: 'webm', label: 'Video WebM' },
  'video/x-matroska': { ext: 'mkv', label: 'Video MKV' },
  'video/x-msvideo': { ext: 'avi', label: 'Video AVI' },
  'video/ogg': { ext: 'ogv', label: 'Video OGV' },
  'video/3gpp': { ext: '3gp', label: 'Video 3GP' },
};

const EXT_MIME_FALLBACK = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.amr': 'audio/amr',
  '.3gp': 'audio/3gpp',
  '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.webm': 'audio/webm',
};

const SUCCESS_METHODS = new Set(['whisper', 'local-whisper', 'local-stt']);
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

// Frequent aliases → ISO-639-1. Any other 2-3 letter code passes through
// (600+ language catalogue idea); the provider decides real coverage.
const LANGUAGE_ALIASES = {
  castellano: 'es',
  espanol: 'es',
  'español': 'es',
  spanish: 'es',
  english: 'en',
  ingles: 'en',
  'inglés': 'en',
  french: 'fr',
  frances: 'fr',
  'francés': 'fr',
  german: 'de',
  aleman: 'de',
  'alemán': 'de',
  portuguese: 'pt',
  portugues: 'pt',
  'português': 'pt',
  italian: 'it',
  italiano: 'it',
};

function normalizeLanguage(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  const base = raw.replace(/_/g, '-').split('-')[0];
  if (/^[a-z]{2,3}$/.test(base)) return base;
  return null;
}

function toSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function formatTimestampSrt(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.floor((total - Math.floor(total)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

function formatTimestampVtt(seconds) {
  return formatTimestampSrt(seconds).replace(',', '.');
}

/** Normalize heterogeneous segments (verbose_json, whisper.cpp, HTTP STT…). */
function normalizeSegments(rawSegments, rawWords) {
  const words = Array.isArray(rawWords)
    ? rawWords
      .map((w) => ({
        start: toSeconds(w.start ?? w.begin),
        end: toSeconds(w.end ?? w.finish),
        text: String(w.text ?? w.word ?? '').trim(),
        speaker: w.speaker != null ? String(w.speaker) : null,
      }))
      .filter((w) => w.text)
    : [];
  if (!Array.isArray(rawSegments)) return { segments: [], words };
  const segments = [];
  for (let i = 0; i < rawSegments.length; i += 1) {
    const s = rawSegments[i] || {};
    const text = String(s.text ?? '').trim();
    if (!text) continue;
    const start = toSeconds(s.start ?? s.begin);
    const end = toSeconds(s.end ?? s.finish);
    segments.push({
      id: Number.isFinite(Number(s.id)) ? Number(s.id) : i,
      start,
      end: end >= start ? end : start,
      text,
      speaker: s.speaker != null ? String(s.speaker) : null,
    });
  }
  return { segments, words };
}

function segmentsToSrt(segments) {
  if (!Array.isArray(segments) || !segments.length) return '';
  return (
    segments
      .map(
        (s, i) =>
          `${i + 1}\n${formatTimestampSrt(s.start)} --> ${formatTimestampSrt(s.end)}\n${s.speaker ? `[${s.speaker}] ${s.text}` : s.text}\n`,
      )
      .join('\n')
      .trim() + '\n'
  );
}

function segmentsToVtt(segments) {
  if (!Array.isArray(segments) || !segments.length) return '';
  return (
    'WEBVTT\n\n' +
    segments
      .map(
        (s) =>
          `${formatTimestampVtt(s.start)} --> ${formatTimestampVtt(s.end)}${s.speaker ? ` <v ${s.speaker}>` : ''}\n${s.text}\n`,
      )
      .join('\n')
      .trim() +
    '\n'
  );
}

function estimateDurationMs(segments, words) {
  let max = 0;
  for (const s of segments || []) max = Math.max(max, toSeconds(s.end));
  for (const w of words || []) max = Math.max(max, toSeconds(w.end));
  return Math.round(max * 1000);
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
  let raw;
  if (typeof options.language === 'string' && options.language.trim()) {
    raw = options.language.trim();
  } else {
    const env = envOf(options);
    if (Object.prototype.hasOwnProperty.call(env, 'WHISPER_LANGUAGE')) {
      const value = String(env.WHISPER_LANGUAGE || '').trim();
      raw = value || undefined;
    } else {
      raw = DEFAULT_LANGUAGE;
    }
  }
  return normalizeLanguage(raw) || raw || undefined;
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

function formatSuccess({ text, method, model, language, segments, words }) {
  const transcript = String(text || '').trim();
  const { segments: normSegments, words: normWords } = normalizeSegments(segments, words);
  const speakers = [...new Set(normSegments.map((s) => s.speaker).filter(Boolean))];
  const durationMs = estimateDurationMs(normSegments, normWords);
  const header = `${method === 'local-whisper' || method === 'local-stt' ? 'Transcripción local' : 'Transcripción'} — ${transcript.length} caracteres` +
    (model ? `, modelo: ${model}` : '') +
    (language ? `, idioma: ${language}` : '') +
    '\n---\n';
  return {
    text: header + transcript,
    transcript,
    method,
    model: model || null,
    language: language || null,
    segments: normSegments,
    words: normWords,
    srt: segmentsToSrt(normSegments),
    vtt: segmentsToVtt(normSegments),
    speakers,
    speakerCount: speakers.length,
    diarized: speakers.length > 0,
    durationMs,
    provider: method,
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

/** HTTP local-STT rung: explicit opt-in so default runs stay hermetic. */
function localSttEnabled(options = {}) {
  if (options.localStt || options.localFetch) return true;
  if (providerOrder(options).includes('local-stt')) return true;
  return /^(1|true|on|yes)$/i.test(String(envOf(options).SIRAGPT_LOCAL_STT_ENABLED || '').trim());
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
      speaker: s.speaker != null ? String(s.speaker) : null,
    })),
    words: transcription && Array.isArray(transcription.words) ? transcription.words : [],
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
    const stitchedWords = [];
    for (const seg of segments) {
      if (options.signal && options.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const part = await transcribeCloudFile(provider, seg.path, 'audio/mpeg', `segment-${seg.index + 1}.mp3`, options, language, prompt);
      const text = String(part.text || '').trim();
      if (text) texts.push(text);
      for (const s of part.segments || []) {
        stitched.push({ start: (s.start || 0) + seg.offsetSeconds, end: (s.end || 0) + seg.offsetSeconds, text: s.text, speaker: s.speaker || null });
      }
      for (const w of part.words || []) {
        stitchedWords.push({ ...w, start: (w.start || 0) + seg.offsetSeconds, end: (w.end || 0) + seg.offsetSeconds });
      }
    }
    return { text: texts.join('\n\n'), segments: stitched, words: stitchedWords, model: provider.model, language: language || null, segmentCount: segments.length };
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
  if (typeof options.localTranscribe === 'function') {
    return options.localTranscribe(filePath, { ...options, language, prompt });
  }
  // Lazy require: checkouts without the binary engine degrade to placeholder
  // instead of crashing at load time.
  let engine;
  try {
    engine = require('./local-whisper-engine');
  } catch (err) {
    throw Object.assign(new Error('local whisper engine not bundled'), { code: 'LOCAL_WHISPER_UNAVAILABLE', cause: err });
  }
  const impl = options.localTranscribe || engine.transcribeLocal;
  return impl(filePath, {
    ...options,
    language,
    prompt,
  });
}

/**
 * VoiceStudio-inspired HTTP rung (opt-in). Injectable through
 * options.localStt for tests.
 */
async function transcribeLocalStt(filePath, fileName, mimeType, options, language, prompt) {
  const diarize = options.diarize === true;
  const requestOpts = { language, prompt, diarize, signal: options.signal };
  if (typeof options.localStt === 'function') {
    const fileBuffer = await fsPromises.readFile(filePath);
    return options.localStt(fileBuffer, fileName, mimeType, requestOpts);
  }
  const fileBuffer = await fsPromises.readFile(filePath);
  const env = envOf(options);
  const config = localStt.getConfig(env);
  return localStt.transcribeViaLocalStt(fileBuffer, fileName, mimeType, {
    language,
    prompt,
    model: options.model || config.model,
    responseFormat: 'verbose_json',
    diarize,
    signal: options.signal,
    fetchImpl: options.localFetch || globalThis.fetch,
    env,
  });
}

/**
 * Transcribe an audio or video file.
 * Returns { text, method: 'local-whisper' | 'local-stt' | 'whisper' | 'placeholder' }
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
        words: cloud.words,
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

  // HTTP local-STT rung (opt-in). Position: just before the binary engine,
  // so TRANSCRIBE_PROVIDERS=local-stt,local is fully local-first.
  if (localSttEnabled(options)) {
    try {
      const payload = await transcribeLocalStt(filePath, fileName, normalizedMime, options, language, prompt);
      const text = String(payload?.text || '').trim();
      if (text.length < 10) {
        return placeholderResult(fileName, label, normalizedMime, 'no_speech');
      }
      const { segments, words } = normalizeSegments(payload?.segments, payload?.words);
      return formatSuccess({
        text,
        method: 'local-stt',
        model: payload?.model || 'local-stt',
        language: normalizeLanguage(payload?.language) || language || null,
        segments,
        words,
      });
    } catch (err) {
      if (isAbortError(err, options.signal)) throw err;
      logSafe(`Local STT endpoint failed (${sanitizeProviderError(err)}); trying the next provider`);
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
      words: local.words,
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
  normalizeLanguage,
  normalizeSegments,
  segmentsToSrt,
  segmentsToVtt,
  formatTimestampSrt,
  formatTimestampVtt,
  localSttEnabled,
  isAbortError,
  isInvalidKeyError,
  hasOpenAiKey,
  AUDIO_MIME_MAP,
  SUCCESS_METHODS,
  get AUDIO_MAX_FILE_BYTES() {
    return audioMaxFileBytes();
  },
};
