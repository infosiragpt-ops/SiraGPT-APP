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

  if (fileSize > maxBytes) {
    return placeholderResult(fileName, label, normalizedMime, 'file_too_large');
  }

  if (hasOpenAiKey(options)) {
    try {
      const cloud = await transcribeOpenAi(
        filePath,
        normalizedMime,
        fileName,
        options,
        language,
        prompt,
        model,
      );
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
        logSafe(`OpenAI Whisper rejected the key (${safe}); falling back to local`);
      } else {
        logSafe(`OpenAI Whisper failed (${safe}); falling back to local`);
      }
    }
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
