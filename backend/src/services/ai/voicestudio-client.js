'use strict';

/**
 * voicestudio-client — thin, zero-dependency client for a private VoiceStudio
 * deployment (https://github.com/debpalash/VoiceStudio, AGPL-3.0).
 *
 * VoiceStudio runs as its own container on the production Docker network
 * (`siragpt-voicestudio:3900`, never published to the host) and exposes:
 *   - the OpenAI-compatible audio API (`/v1/audio/speech`, `/v1/audio/transcriptions`)
 *   - voice profiles (zero-shot cloning from a short reference clip)
 *   - the dubbing pipeline (upload → transcribe → translate → generate → download)
 *   - chapterized audiobooks (`/audiobook`, `/audiobook/import`)
 *
 * Everything here is "Sira Voz" for the product: 100 % local, no third-party
 * account, no per-character billing. Secrets: only `VOICESTUDIO_API_KEY`
 * (the container's OMNIVOICE_API_KEY) which is sent as a Bearer token and
 * never logged.
 *
 * Injectable `fetch` + `spawn` so unit tests never touch the network.
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TTS_CHUNK_CHARS = 3000;
const MAX_SPEECH_INPUT_CHARS = 4096; // VoiceStudio's /v1/audio/speech hard cap
const SIRA_VOZ_MODEL_RE = /sira[-_\s]?voz|voice[-_\s]?studio|omnivoice/i;

// SiraGPT's composer speaks in English language names ("Spanish"); VoiceStudio's
// engines expect the same display names (frontend/src/languages.json) and
// `Auto`. The dub pipeline additionally wants an ISO 639-1 code for ffmpeg
// metadata and translation.
const LANGUAGE_CODES = Object.freeze({
  auto: null,
  english: 'en',
  spanish: 'es',
  german: 'de',
  french: 'fr',
  portuguese: 'pt',
  italian: 'it',
  afrikaans: 'af',
  arabic: 'ar',
  armenian: 'hy',
  assamese: 'as',
  azerbaijani: 'az',
  belarusian: 'be',
  bengali: 'bn',
  catalan: 'ca',
  chinese: 'zh',
  'chinese (simplified)': 'zh',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  finnish: 'fi',
  greek: 'el',
  hebrew: 'he',
  hindi: 'hi',
  hungarian: 'hu',
  indonesian: 'id',
  japanese: 'ja',
  korean: 'ko',
  norwegian: 'no',
  polish: 'pl',
  quechua: 'qu',
  romanian: 'ro',
  russian: 'ru',
  swedish: 'sv',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
});

const LANGUAGE_NAMES = Object.freeze(Object.entries(LANGUAGE_CODES).reduce((acc, [name, code]) => {
  if (code && !acc[code]) acc[code] = name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\(simplified\)/i, '(Simplified)');
  return acc;
}, {}));

class VoiceStudioError extends Error {
  constructor(message, { status = 0, code = 'VOICESTUDIO_ERROR', detail = null, retryable = false } = {}) {
    super(message);
    this.name = 'VoiceStudioError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

function envOf(options = {}) {
  return options.env || process.env;
}

function baseUrl(options = {}) {
  return String(envOf(options).VOICESTUDIO_URL || '').trim().replace(/\/+$/, '');
}

function apiKey(options = {}) {
  return String(envOf(options).VOICESTUDIO_API_KEY || '').trim();
}

function isConfigured(options = {}) {
  return Boolean(baseUrl(options));
}

function isSiraVozModel(value) {
  return SIRA_VOZ_MODEL_RE.test(String(value || ''));
}

function languageCode(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_CODES, lower)) return LANGUAGE_CODES[lower];
  if (/^[a-z]{2}(-[a-z]{2,4})?$/i.test(raw)) return raw.slice(0, 2).toLowerCase();
  return null;
}

function languageName(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Auto';
  if (/^auto$/i.test(raw)) return 'Auto';
  const lower = raw.toLowerCase();
  if (LANGUAGE_NAMES[lower]) return LANGUAGE_NAMES[lower];
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_CODES, lower)) {
    return lower.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return raw;
}

function getFetch(options = {}) {
  if (typeof options.fetchImpl === 'function') return options.fetchImpl;
  if (typeof globalThis.fetch !== 'function') {
    throw new VoiceStudioError('fetch is not available in this runtime', { code: 'NO_FETCH' });
  }
  return globalThis.fetch.bind(globalThis);
}

function authHeaders(options = {}, extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const key = apiKey(options);
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function combinedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('VoiceStudio request timed out')), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function readErrorDetail(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.detail === 'string') return parsed.detail;
      if (parsed.detail && typeof parsed.detail === 'object') {
        return parsed.detail.message || parsed.detail.reason || JSON.stringify(parsed.detail).slice(0, 400);
      }
      if (typeof parsed.error === 'string') return parsed.error;
    }
  } catch {
    /* plain text body */
  }
  return text.slice(0, 400);
}

async function request(pathname, { method = 'GET', headers = {}, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS, raw = false, ...options } = {}) {
  const base = baseUrl(options);
  if (!base) {
    throw new VoiceStudioError('Sira Voz (VoiceStudio) no está configurado', { code: 'VOICESTUDIO_NOT_CONFIGURED', status: 503 });
  }
  const fetchImpl = getFetch(options);
  const bound = combinedSignal(signal, timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}${pathname}`, {
      method,
      headers: authHeaders(options, headers),
      body,
      signal: bound.signal,
      // Node's undici needs duplex for streaming request bodies.
      ...(body && typeof body.pipe === 'function' ? { duplex: 'half' } : {}),
    });
  } catch (err) {
    bound.cleanup();
    if (signal && signal.aborted) throw err;
    const message = String(err?.message || err);
    throw new VoiceStudioError(`No se pudo contactar a Sira Voz (${message})`, {
      code: /timed out/i.test(message) ? 'VOICESTUDIO_TIMEOUT' : 'VOICESTUDIO_UNREACHABLE',
      status: 503,
      retryable: true,
    });
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    bound.cleanup();
    throw new VoiceStudioError(detail || `VoiceStudio respondió ${response.status}`, {
      status: response.status,
      code: response.status === 401 ? 'VOICESTUDIO_UNAUTHORIZED'
        : response.status === 503 ? 'VOICESTUDIO_BUSY'
          : response.status === 404 ? 'VOICESTUDIO_NOT_FOUND'
            : 'VOICESTUDIO_HTTP_ERROR',
      detail,
      retryable: response.status === 503 || response.status === 429,
    });
  }
  if (raw) {
    // Caller consumes the body; release the timeout once the stream ends.
    const cleanup = bound.cleanup;
    return Object.assign(response, { releaseTimeout: cleanup });
  }
  try {
    const contentType = String(response.headers.get('content-type') || '');
    if (/json/i.test(contentType)) return await response.json();
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    bound.cleanup();
  }
}

// ── Multipart helpers (Node ≥ 20 has global FormData/Blob; openAsBlob streams) ──

async function fileBlob(filePath, { mime = 'application/octet-stream', maxBytes = 0 } = {}) {
  if (maxBytes > 0) {
    const stat = await fsPromises.stat(filePath);
    if (stat.size > maxBytes) {
      throw new VoiceStudioError(`El archivo supera el máximo permitido (${Math.round(maxBytes / (1024 * 1024))} MB)`, {
        code: 'FILE_TOO_LARGE', status: 413,
      });
    }
  }
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath, { type: mime });
  }
  const buffer = await fsPromises.readFile(filePath);
  return new Blob([buffer], { type: mime });
}

function multipart(fields = {}, files = []) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }
  for (const file of files) {
    if (!file || !file.blob) continue;
    form.append(file.field, file.blob, file.filename || 'file.bin');
  }
  return form;
}

// ── Health / discovery ──────────────────────────────────────────────────────

async function health(options = {}) {
  if (!isConfigured(options)) return { ok: false, configured: false, status: 'not_configured' };
  try {
    const body = await request('/health', { ...options, timeoutMs: options.timeoutMs || 8000 });
    return {
      ok: body?.status === 'ok',
      configured: true,
      status: body?.status || 'unknown',
      device: body?.device || null,
      version: body?.version || null,
      step: body?.step || null,
      label: body?.label || null,
    };
  } catch (err) {
    if (err instanceof VoiceStudioError && err.status === 503 && err.detail) {
      // /health answers 503 with {status:"starting", step, label} while the
      // deferred startup runs — that is "not ready yet", not "down".
      return { ok: false, configured: true, status: 'starting', detail: err.detail };
    }
    return { ok: false, configured: true, status: 'unreachable', error: err?.code || err?.message || String(err) };
  }
}

async function listEngines(options = {}) {
  return request('/engines', options);
}

// ── Voice profiles (cloning) ───────────────────────────────────────────────

async function listProfiles(options = {}) {
  const rows = await request('/profiles', options);
  return Array.isArray(rows) ? rows : [];
}

async function getProfile(profileId, options = {}) {
  return request(`/profiles/${encodeURIComponent(profileId)}`, options);
}

/**
 * Create a zero-shot clone profile from a reference clip (3–20 s recommended).
 * Returns { id, name, kind } — the VoiceStudio profile id is what the
 * OpenAI-compatible `voice` field and the dub `profile_id` accept.
 */
async function createCloneProfile({ name, audioPath, filename, mime, refText = '', language = 'Auto', instruct = '' } = {}, options = {}) {
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) throw new VoiceStudioError('La voz necesita un nombre', { code: 'NAME_REQUIRED', status: 400 });
  if (!audioPath) throw new VoiceStudioError('Falta la muestra de audio', { code: 'AUDIO_REQUIRED', status: 400 });
  const blob = await fileBlob(audioPath, { mime: mime || 'audio/wav', maxBytes: options.maxBytes || 25 * 1024 * 1024 });
  const form = multipart(
    {
      name: cleanName,
      ref_text: String(refText || '').slice(0, 1000),
      instruct: String(instruct || '').slice(0, 400),
      language: languageName(language),
      kind: 'clone',
    },
    [{ field: 'ref_audio', blob, filename: filename || path.basename(audioPath) }],
  );
  return request('/profiles', { ...options, method: 'POST', body: form, timeoutMs: options.timeoutMs || 120000 });
}

async function deleteProfile(profileId, options = {}) {
  return request(`/profiles/${encodeURIComponent(profileId)}`, { ...options, method: 'DELETE' });
}

/** Raw Response for the profile's reference sample (audio/wav). */
async function fetchProfileAudio(profileId, options = {}) {
  return request(`/profiles/${encodeURIComponent(profileId)}/audio`, {
    ...options,
    raw: true,
    headers: { Accept: 'audio/*' },
    timeoutMs: options.timeoutMs || 60000,
  });
}

// ── Text-to-speech ─────────────────────────────────────────────────────────

/**
 * Split long narrations at sentence boundaries so every request stays under
 * VoiceStudio's 4096-char cap. Never splits inside a word.
 */
function chunkText(text, maxChars = DEFAULT_TTS_CHUNK_CHARS) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const limit = Math.max(200, Math.min(maxChars, MAX_SPEECH_INPUT_CHARS - 96));
  if (clean.length <= limit) return [clean];
  const sentences = clean.split(/(?<=[.!?…]["»)]?)\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      const words = sentence.split(/\s+/).flatMap((word) => {
        // A single "word" longer than the cap (URLs, pasted ids) is hard-split.
        if (word.length <= limit) return [word];
        const pieces = [];
        for (let i = 0; i < word.length; i += limit) pieces.push(word.slice(i, i + limit));
        return pieces;
      });
      let piece = '';
      for (const word of words) {
        if ((piece + ' ' + word).trim().length > limit) { if (piece) chunks.push(piece.trim()); piece = word; } else piece = `${piece} ${word}`.trim();
      }
      if (piece) chunks.push(piece.trim());
      continue;
    }
    if ((current + ' ' + sentence).trim().length > limit) flush();
    current = `${current} ${sentence}`.trim();
  }
  flush();
  return chunks;
}

/**
 * One OpenAI-compatible speech call. Returns { buffer, mime, ext }.
 * `voice` is a VoiceStudio profile id, "default", or an OpenAI alias.
 */
async function synthesizeSpeech({ text, voice = 'default', language = null, speed = 1, instruct = '', format = 'wav', model, signal } = {}, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new VoiceStudioError('Text is required for speech generation', { code: 'TEXT_REQUIRED', status: 400 });
  if (input.length > MAX_SPEECH_INPUT_CHARS) {
    throw new VoiceStudioError(`El texto supera ${MAX_SPEECH_INPUT_CHARS} caracteres por petición`, { code: 'TEXT_TOO_LONG', status: 400 });
  }
  const payload = {
    model: model || envOf(options).VOICESTUDIO_TTS_MODEL || 'tts-1',
    input,
    voice: String(voice || 'default').trim() || 'default',
    response_format: format,
    speed: Math.min(4, Math.max(0.25, Number(speed) || 1)),
  };
  const langName = languageName(language);
  if (langName && langName !== 'Auto') payload.language = langName;
  if (instruct) payload.instruct = String(instruct).slice(0, 400);
  const response = await request('/v1/audio/speech', {
    ...options,
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'application/json', Accept: 'audio/*' },
    body: JSON.stringify(payload),
    signal,
    timeoutMs: options.timeoutMs || Number(envOf(options).VOICESTUDIO_TTS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  });
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new VoiceStudioError('VoiceStudio devolvió un audio vacío', { code: 'EMPTY_AUDIO', status: 502 });
    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim() || 'audio/wav';
    const ext = mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/flac' ? 'flac' : mime === 'audio/ogg' ? 'ogg' : 'wav';
    return { buffer, mime, ext };
  } finally {
    response.releaseTimeout?.();
  }
}

function ffmpegBin(options = {}) {
  return envOf(options).FFMPEG_PATH || 'ffmpeg';
}

function runFfmpeg(args, options = {}) {
  const spawnImpl = options.spawnImpl || require('child_process').spawn;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(ffmpegBin(options), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new VoiceStudioError(`ffmpeg exited with ${code}: ${stderr.slice(-300)}`, { code: 'FFMPEG_FAILED', status: 500 }));
    });
  });
}

/**
 * Full narration → one MP3 on disk. Long texts are chunked, synthesized in
 * order and joined with ffmpeg (already in the backend image). Returns
 * { audioPath, sizeBytes, mime, format, chunks }.
 */
async function synthesizeToFile({ text, voice, language, speed, instruct, outputPath, signal, onProgress } = {}, options = {}) {
  const chunks = chunkText(text, Number(envOf(options).VOICESTUDIO_TTS_CHUNK_CHARS) || DEFAULT_TTS_CHUNK_CHARS);
  if (!chunks.length) throw new VoiceStudioError('Text is required for speech generation', { code: 'TEXT_REQUIRED', status: 400 });
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sira-voz-'));
  try {
    const parts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const part = await synthesizeSpeech({ text: chunks[i], voice, language, speed, instruct, format: 'wav', signal }, options);
      const partPath = path.join(tmpDir, `part-${String(i).padStart(4, '0')}.${part.ext}`);
      await fsPromises.writeFile(partPath, part.buffer);
      parts.push(partPath);
      if (typeof onProgress === 'function') onProgress({ current: i + 1, total: chunks.length });
    }
    const target = outputPath || path.join(tmpDir, `voz-${randomUUID()}.mp3`);
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const listPath = path.join(tmpDir, 'concat.txt');
    await fsPromises.writeFile(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '128k', target], options);
    const stat = await fsPromises.stat(target);
    return { audioPath: target, sizeBytes: stat.size, mime: 'audio/mpeg', format: 'mp3', chunks: chunks.length };
  } finally {
    if (!outputPath) {
      // Caller asked for a temp file — keep it, drop only the parts.
      for (const entry of await fsPromises.readdir(tmpDir).catch(() => [])) {
        if (/^part-|^concat\.txt$/.test(entry)) await fsPromises.rm(path.join(tmpDir, entry), { force: true }).catch(() => {});
      }
    } else {
      await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ── Speech-to-text (WhisperX / faster-whisper inside VoiceStudio) ───────────

/**
 * OpenAI-compatible transcription. Returns the verbose_json shape:
 * { text, language, duration, segments:[{start,end,text}] }.
 */
async function transcribe({ filePath, filename, mime, language = null, model, prompt, responseFormat = 'verbose_json', signal } = {}, options = {}) {
  if (!filePath) throw new VoiceStudioError('Falta el archivo de audio', { code: 'AUDIO_REQUIRED', status: 400 });
  const blob = await fileBlob(filePath, { mime: mime || 'application/octet-stream', maxBytes: options.maxBytes || 0 });
  const fields = { model: model || envOf(options).VOICESTUDIO_ASR_MODEL || 'whisper-1', response_format: responseFormat };
  const code = languageCode(language);
  if (code) fields.language = code;
  if (prompt) fields.prompt = String(prompt).slice(0, 1000);
  const form = multipart(fields, [{ field: 'file', blob, filename: filename || path.basename(filePath) }]);
  const body = await request('/v1/audio/transcriptions', {
    ...options,
    method: 'POST',
    body: form,
    signal,
    timeoutMs: options.timeoutMs || Number(envOf(options).VOICESTUDIO_ASR_TIMEOUT_MS) || DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  });
  if (typeof body === 'string') return { text: body, language: code || null, duration: null, segments: [] };
  return {
    text: String(body?.text || '').trim(),
    language: body?.language || code || null,
    duration: Number.isFinite(Number(body?.duration)) ? Number(body.duration) : null,
    segments: Array.isArray(body?.segments)
      ? body.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
      : [],
  };
}

// ── Server-sent events reader (dub prep/generate tasks, audiobook renders) ──

/**
 * Consume a `text/event-stream` (or ndjson) body. Calls onEvent(obj) for every
 * parsed JSON payload and resolves with the events array when the stream ends
 * or `until(obj)` returns true.
 */
async function readSse(response, { onEvent, until, signal } = {}) {
  const events = [];
  const body = response.body;
  if (!body) return events;
  const decoder = new TextDecoder();
  let buffered = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return null;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  };
  const reader = body.getReader ? body.getReader() : null;
  let stopped = false;
  const consume = async (chunkText) => {
    buffered += chunkText;
    let idx;
    while ((idx = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, idx);
      buffered = buffered.slice(idx + 1);
      const obj = handleLine(line);
      if (!obj) continue;
      events.push(obj);
      if (typeof onEvent === 'function') {
        try { onEvent(obj); } catch { /* observer errors never break the stream */ }
      }
      if (typeof until === 'function' && until(obj)) { stopped = true; return true; }
    }
    return false;
  };
  try {
    if (reader) {
      for (;;) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const { done, value } = await reader.read();
        if (done) break;
        if (await consume(decoder.decode(value, { stream: true }))) { await reader.cancel().catch(() => {}); break; }
      }
    } else {
      for await (const chunk of body) {
        if (await consume(decoder.decode(chunk, { stream: true }))) break;
      }
    }
    if (!stopped && buffered.trim()) await consume('\n');
  } finally {
    response.releaseTimeout?.();
  }
  return events;
}

async function streamTask(taskId, { onEvent, until, signal, afterSeq = 0 } = {}, options = {}) {
  const response = await request(`/tasks/stream/${encodeURIComponent(taskId)}?after_seq=${Number(afterSeq) || 0}`, {
    ...options,
    raw: true,
    headers: { Accept: 'text/event-stream' },
    signal,
    timeoutMs: options.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  });
  return readSse(response, { onEvent, until, signal });
}

async function getJob(jobId, options = {}) {
  return request(`/jobs/${encodeURIComponent(jobId)}`, options);
}

async function cancelTask(taskId, options = {}) {
  return request(`/tasks/cancel/${encodeURIComponent(taskId)}`, { ...options, method: 'POST' });
}

// ── Dubbing ────────────────────────────────────────────────────────────────

async function dubUpload({ filePath, filename, mime, inputType = 'video', sourceLang = null, signal } = {}, options = {}) {
  const blob = await fileBlob(filePath, { mime: mime || (inputType === 'audio' ? 'audio/mpeg' : 'video/mp4'), maxBytes: options.maxBytes || 0 });
  const fields = { input_type: inputType };
  const code = languageCode(sourceLang);
  if (code) fields.source_lang = code;
  const form = multipart(fields, [{ field: 'video', blob, filename: filename || path.basename(filePath) }]);
  return request('/dub/upload', { ...options, method: 'POST', body: form, signal, timeoutMs: options.timeoutMs || 30 * 60 * 1000 });
}

/** Wait for the ingest task (extract → demucs → scenes). Resolves on `ready`. */
async function waitForDubReady(taskId, { onEvent, signal } = {}, options = {}) {
  let ready = null;
  let failure = null;
  await streamTask(taskId, {
    signal,
    onEvent: (evt) => {
      if (typeof onEvent === 'function') onEvent(evt);
      if (evt?.type === 'ready') ready = evt;
      if (evt?.type === 'error' || evt?.type === 'cancelled') failure = evt;
    },
    until: (evt) => evt?.type === 'ready' || evt?.type === 'error' || evt?.type === 'cancelled',
  }, options);
  if (ready) return ready;
  if (failure) {
    throw new VoiceStudioError(failure.reason || failure.detail || failure.error || 'La preparación del vídeo falló', { code: 'DUB_PREP_FAILED', status: 502, detail: failure });
  }
  // The stream ended without a terminal event (server restart); check the job row.
  const job = await getJob(taskId, options).catch(() => null);
  if (job && job.status === 'done') return { type: 'ready', job_id: job.id };
  throw new VoiceStudioError('La preparación del vídeo terminó sin confirmación', { code: 'DUB_PREP_UNKNOWN', status: 502 });
}

async function dubTranscribe(jobId, { numSpeakers = null, signal } = {}, options = {}) {
  const qs = Number.isInteger(numSpeakers) && numSpeakers > 0 ? `?num_speakers=${numSpeakers}` : '';
  const body = await request(`/dub/transcribe/${encodeURIComponent(jobId)}${qs}`, {
    ...options,
    method: 'POST',
    signal,
    timeoutMs: options.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  });
  return {
    jobId: body?.job_id || jobId,
    segments: Array.isArray(body?.segments) ? body.segments : [],
    fullTranscript: String(body?.full_transcript || ''),
    sourceLang: body?.source_lang || null,
  };
}

/** VoiceStudio's own translator (offline NLLB by default) — fallback path. */
async function dubTranslate({ segments, targetLang, sourceLang = null, provider = 'nllb', signal } = {}, options = {}) {
  const payload = {
    segments: segments.map((s) => ({ id: String(s.id), text: String(s.text || '') })),
    target_lang: languageCode(targetLang) || String(targetLang || 'en'),
    provider,
  };
  const src = languageCode(sourceLang);
  if (src) payload.source_lang = src;
  return request('/dub/translate', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
    timeoutMs: options.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  });
}

async function dubGenerate(jobId, payload, { signal } = {}, options = {}) {
  const body = await request(`/dub/generate/${encodeURIComponent(jobId)}`, {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
    timeoutMs: options.timeoutMs || 120000,
  });
  return { taskId: body?.task_id || null };
}

/** Follow the generate task until `done`; returns the done event. */
async function waitForDubDone(taskId, { onEvent, signal } = {}, options = {}) {
  let done = null;
  let failure = null;
  await streamTask(taskId, {
    signal,
    onEvent: (evt) => {
      if (typeof onEvent === 'function') onEvent(evt);
      if (evt?.type === 'done') done = evt;
      if (evt?.type === 'error' || evt?.type === 'cancelled' || evt?.type === 'failed') failure = evt;
    },
    until: (evt) => ['done', 'error', 'cancelled', 'failed'].includes(evt?.type),
  }, options);
  if (done) return done;
  if (failure) {
    throw new VoiceStudioError(failure.reason || failure.detail || failure.error || 'La generación del doblaje falló', { code: 'DUB_GENERATE_FAILED', status: 502, detail: failure });
  }
  const job = await getJob(taskId, options).catch(() => null);
  if (job && job.status === 'done') return { type: 'done' };
  throw new VoiceStudioError('La generación del doblaje terminó sin confirmación', { code: 'DUB_GENERATE_UNKNOWN', status: 502 });
}

async function downloadToFile(pathname, outPath, { signal, timeoutMs } = {}, options = {}) {
  const response = await request(pathname, {
    ...options,
    raw: true,
    headers: { Accept: '*/*' },
    signal,
    timeoutMs: timeoutMs || 30 * 60 * 1000,
  });
  await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
  try {
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');
    const nodeStream = response.body && typeof response.body.pipe === 'function'
      ? response.body
      : Readable.fromWeb(response.body);
    await pipeline(nodeStream, fs.createWriteStream(outPath));
  } finally {
    response.releaseTimeout?.();
  }
  const stat = await fsPromises.stat(outPath);
  return {
    path: outPath,
    sizeBytes: stat.size,
    mime: String(response.headers.get('content-type') || '').split(';')[0].trim() || null,
  };
}

/**
 * Final dub export: mp4 (video jobs, dubbed track as default audio) or, for
 * audio-only jobs, the container named by `outFormat` (wav|m4a|mp3|flac).
 */
async function dubDownloadVideo({ jobId, outPath, defaultTrack = '', preserveBg = true, includeTracks = '', outFormat = '', signal } = {}, options = {}) {
  const params = new URLSearchParams();
  params.set('preserve_bg', preserveBg ? 'true' : 'false');
  if (defaultTrack) params.set('default_track', defaultTrack);
  if (includeTracks) params.set('include_tracks', includeTracks);
  if (outFormat) params.set('out_format', outFormat);
  return downloadToFile(`/dub/download/${encodeURIComponent(jobId)}?${params.toString()}`, outPath, { signal }, options);
}

/** Dubbed audio track of a job as WAV (mixed with the background bed when preserveBg). */
async function dubDownloadAudio({ jobId, lang, outPath, preserveBg = true, signal } = {}, options = {}) {
  const params = new URLSearchParams();
  if (lang) params.set('lang', lang);
  params.set('preserve_bg', preserveBg ? 'true' : 'false');
  return downloadToFile(`/dub/download-audio/${encodeURIComponent(jobId)}?${params.toString()}`, outPath, { signal }, options);
}

async function dubSubtitles({ jobId, format = 'srt', lang = '', signal } = {}, options = {}) {
  const suffix = lang ? `?lang=${encodeURIComponent(lang)}` : '';
  const response = await request(`/dub/${format === 'vtt' ? 'vtt' : 'srt'}/${encodeURIComponent(jobId)}${suffix}`, {
    ...options, raw: true, headers: { Accept: 'text/plain' }, signal, timeoutMs: 60000,
  });
  try {
    return await response.text();
  } finally {
    response.releaseTimeout?.();
  }
}

// ── Audiobooks ─────────────────────────────────────────────────────────────

/** txt/md/epub/pdf → chapterized script `{ text, chapters }`. */
async function audiobookImport({ filePath, filename, mime, signal } = {}, options = {}) {
  const blob = await fileBlob(filePath, { mime: mime || 'application/octet-stream', maxBytes: options.maxBytes || 64 * 1024 * 1024 });
  const form = multipart({}, [{ field: 'file', blob, filename: filename || path.basename(filePath) }]);
  const body = await request('/audiobook/import', { ...options, method: 'POST', body: form, signal, timeoutMs: options.timeoutMs || 10 * 60 * 1000 });
  return { text: String(body?.text || ''), chapters: Number(body?.chapters) || 0 };
}

async function audiobookPlan({ text, defaultVoice = null } = {}, options = {}) {
  return request('/audiobook/plan', {
    ...options,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: String(text || ''), default_voice: defaultVoice || null }),
    timeoutMs: 60000,
  });
}

/**
 * Render a chapterized audiobook. Streams SSE progress (started, chapter,
 * assembling, mastering, done|error|stopped). Resolves with the `done` event
 * ({ output, chapters, duration_s }).
 */
async function audiobookRender({ text, defaultVoice = null, language = null, format = 'm4b', bitrate = '128k', loudness = null, metadata = null, voiceMap = null, onEvent, signal } = {}, options = {}) {
  const payload = {
    text: String(text || ''),
    default_voice: defaultVoice || null,
    language: language && languageName(language) !== 'Auto' ? languageName(language) : null,
    format: format === 'mp3' ? 'mp3' : 'm4b',
    bitrate: bitrate || '128k',
    loudness: loudness || null,
    metadata: metadata && typeof metadata === 'object' ? metadata : null,
    voice_map: voiceMap && typeof voiceMap === 'object' ? voiceMap : null,
  };
  const response = await request('/audiobook', {
    ...options,
    method: 'POST',
    raw: true,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
    timeoutMs: options.timeoutMs || Number(envOf(options).VOICESTUDIO_AUDIOBOOK_TIMEOUT_MS) || 6 * 60 * 60 * 1000,
  });
  let done = null;
  let failure = null;
  await readSse(response, {
    signal,
    onEvent: (evt) => {
      if (typeof onEvent === 'function') onEvent(evt);
      if (evt?.type === 'done') done = evt;
      if (evt?.type === 'error' || evt?.type === 'stopped') failure = evt;
    },
    until: (evt) => ['done', 'error', 'stopped'].includes(evt?.type),
  });
  if (done) return done;
  throw new VoiceStudioError(failure?.error || failure?.reason || 'La generación del audiolibro falló', { code: 'AUDIOBOOK_FAILED', status: 502, detail: failure });
}

/** Files in VoiceStudio's OUTPUTS_DIR are served under /audio/<name>. */
async function downloadOutput(name, outPath, { signal } = {}, options = {}) {
  const safe = path.basename(String(name || ''));
  if (!safe || safe !== name) throw new VoiceStudioError('Nombre de salida inválido', { code: 'BAD_OUTPUT_NAME', status: 400 });
  return downloadToFile(`/audio/${encodeURIComponent(safe)}`, outPath, { signal }, options);
}

module.exports = {
  VoiceStudioError,
  DEFAULT_TTS_CHUNK_CHARS,
  MAX_SPEECH_INPUT_CHARS,
  SIRA_VOZ_MODEL_RE,
  LANGUAGE_CODES,
  isConfigured,
  isSiraVozModel,
  languageCode,
  languageName,
  baseUrl,
  health,
  listEngines,
  listProfiles,
  getProfile,
  createCloneProfile,
  deleteProfile,
  fetchProfileAudio,
  chunkText,
  synthesizeSpeech,
  synthesizeToFile,
  transcribe,
  readSse,
  streamTask,
  getJob,
  cancelTask,
  dubUpload,
  waitForDubReady,
  dubTranscribe,
  dubTranslate,
  dubGenerate,
  waitForDubDone,
  dubDownloadVideo,
  dubDownloadAudio,
  dubSubtitles,
  audiobookImport,
  audiobookPlan,
  audiobookRender,
  downloadOutput,
  downloadToFile,
  request,
};
