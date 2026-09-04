'use strict';

/**
 * voice-studio-local-stt — Local-first speech-to-text client, VoiceStudio-inspired.
 *
 * VoiceStudio (AGPL-3.0, https://github.com/debpalash/VoiceStudio) demuestra que
 * la transcripción profesional puede ser 100% local vía una API compatible con
 * OpenAI: `POST {baseUrl}/v1/audio/transcriptions` con multipart/form-data
 * (file, model, language?, prompt?, response_format?, temperature?).
 *
 * Este módulo NO copia código de VoiceStudio: implementa un cliente mínimo
 * OpenAI-compatible contra cualquier backend local que exponga ese contrato
 * (VoiceStudio en :3900, faster-whisper-server, whisper.cpp server, etc.).
 * Sin red nueva, sin deps nuevas (fetch + FormData globales de Node 18+).
 *
 * Nota: `audio-transcriber.js` lo usa como rung OPT-IN (TRANSCRIBE_PROVIDERS
 * con `local-stt`, o SIRAGPT_LOCAL_STT_ENABLED=1). Este cliente por sí solo
 * no decide política: si lo llamas directo, llama siempre.
 *
 * Env:
 *   SIRAGPT_LOCAL_STT_URL         — endpoint completo (default http://127.0.0.1:3900/v1/audio/transcriptions)
 *   SIRAGPT_LOCAL_STT_ENABLED     — 1/true/on para intentar local primero (default 1)
 *   SIRAGPT_LOCAL_STT_TIMEOUT_MS  — timeout ms (default 120000)
 *   SIRAGPT_LOCAL_STT_MODEL       — model id enviado al backend local (default whisper-1)
 *   SIRAGPT_LOCAL_STT_MAX_BYTES   — tope para vía local (default 512MB, igual que media-runtime)
 */

const DEFAULT_URL = 'http://127.0.0.1:3900/v1/audio/transcriptions';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const norm = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(norm)) return true;
  if (['0', 'false', 'off', 'no'].includes(norm)) return false;
  return fallback;
}

function getConfig(env = process.env) {
  return {
    url: String(env.SIRAGPT_LOCAL_STT_URL || DEFAULT_URL).trim() || DEFAULT_URL,
    enabled: parseBool(env.SIRAGPT_LOCAL_STT_ENABLED, true),
    timeoutMs: Number.parseInt(env.SIRAGPT_LOCAL_STT_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS,
    model: String(env.SIRAGPT_LOCAL_STT_MODEL || 'whisper-1').trim() || 'whisper-1',
    maxBytes: Number.parseInt(env.SIRAGPT_LOCAL_STT_MAX_BYTES || String(DEFAULT_MAX_BYTES), 10) || DEFAULT_MAX_BYTES,
  };
}

function isLocalSttEnabled(env = process.env) {
  return getConfig(env).enabled;
}

/**
 * Llama al backend local STT con contrato OpenAI-compatible.
 * @param {Buffer} fileBuffer bytes del audio/video
 * @param {string} filename nombre con extensión
 * @param {string} mimeType mime del archivo
 * @param {object} opts { language, prompt, model, responseFormat, diarize, signal, fetchImpl, timeoutMs, url }
 * @returns {Promise<object>} payload crudo del backend (text/segments/words/language/duration...)
 */
async function transcribeViaLocalStt(fileBuffer, filename, mimeType, opts = {}) {
  const config = getConfig(opts.env || process.env);
  const url = opts.url || config.url;
  const timeoutMs = opts.timeoutMs || config.timeoutMs;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('fetch no disponible para STT local');
    err.code = 'LOCAL_STT_NO_FETCH';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('local STT timeout')), timeoutMs);
  const onAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const form = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' });
    form.append('file', blob, filename || 'audio.wav');
    form.append('model', opts.model || config.model);
    if (opts.language) form.append('language', String(opts.language));
    if (opts.prompt) form.append('prompt', String(opts.prompt).slice(0, 1000));
    // VoiceStudio acepta json/text/verbose_json/srt/vtt — pedimos verbose por defecto.
    form.append('response_format', opts.responseFormat || 'verbose_json');
    if (typeof opts.temperature === 'number') form.append('temperature', String(opts.temperature));

    const res = await fetchImpl(url, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`local STT HTTP ${res.status}`);
      err.code = res.status === 404 ? 'LOCAL_STT_NOT_FOUND' : 'LOCAL_STT_HTTP_ERROR';
      err.status = res.status;
      throw err;
    }
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('text/') || /srt|vtt|subrip/.test(contentType)) {
      const raw = await res.text();
      return { text: raw, _rawFormat: contentType.includes('vtt') ? 'vtt' : 'srt' };
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError' || /abort|timeout/i.test(err?.message || '')) {
      const timeout = new Error(`local STT sin respuesta en ${timeoutMs}ms (${url})`);
      timeout.code = 'LOCAL_STT_TIMEOUT';
      throw timeout;
    }
    if (!err.code) err.code = 'LOCAL_STT_UNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener?.('abort', onAbort);
  }
}

module.exports = {
  DEFAULT_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  getConfig,
  isLocalSttEnabled,
  transcribeViaLocalStt,
};
