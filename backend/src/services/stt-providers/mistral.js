'use strict';

/**
 * Mistral Voxtral transcription (`POST /v1/audio/transcriptions`), multipart
 * as Mistral documents it: `model`, `file`, optional `language`, one
 * `timestamp_granularities` field per granularity (not the OpenAI SDK's
 * `timestamp_granularities[]`), optional `diarize`. Response: `{ text,
 * language, segments: [{ text, start, end }] }` in seconds. Opt-in rung
 * (`mistral` in TRANSCRIBE_PROVIDERS). Errors carry `status` and `headers`
 * for the engine's classifiers; a request that outlives its budget fails as
 * a timeout (ETIMEDOUT), never as the user's abort.
 */

const fs = require('fs');
const { boundedSignal, headersObject, round3 } = require('./http-shared');

const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
const DEFAULT_MISTRAL_TRANSCRIBE_MODEL = 'voxtral-mini-latest';

function cleanBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_MISTRAL_BASE_URL;
}

function mistralApiKey(env = process.env) {
  return String(env.MISTRAL_API_KEY || '').trim();
}

function mistralTranscribeModel(env = process.env) {
  return String(env.MISTRAL_TRANSCRIBE_MODEL || '').trim() || DEFAULT_MISTRAL_TRANSCRIBE_MODEL;
}

function httpError(status, message, headers = null, body = null) {
  const err = new Error(message);
  err.status = status;
  err.provider = 'mistral';
  if (headers) err.headers = headers;
  const code = body && typeof body === 'object' ? (body.type || body.code) : null;
  if (code) err.code = String(code).slice(0, 60);
  return err;
}

function segmentsFromMistral(payload) {
  const timed = (item) => Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end));
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  return segments.filter(timed).map((segment) => {
    const out = { start: round3(segment.start), end: round3(segment.end), text: String(segment.text || '').trim() };
    const speaker = segment.speaker ?? segment.speaker_id;
    if (speaker != null && speaker !== '') out.speaker = String(speaker);
    return out;
  }).filter((segment) => segment.text);
}

async function transcribeMistralFile({ filePath, mimeType, fileName, language, signal, timeoutMs, model, diarize = false, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!filePath) throw Object.assign(new Error('Audio file path is required for Mistral STT.'), { code: 'mistral_audio_file_required' });
  const key = mistralApiKey(env);
  if (!key) throw Object.assign(new Error('MISTRAL_API_KEY is required.'), { code: 'mistral_key_required', status: 401 });
  const chosenModel = String(model || '').trim() || mistralTranscribeModel(env);
  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('model', chosenModel);
  const forced = String(language || '').trim().toLowerCase();
  if (forced) form.append('language', forced);
  form.append('timestamp_granularities', 'segment');
  if (diarize) form.append('diarize', 'true');
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/flac' }), fileName || 'audio.flac');
  const bounded = boundedSignal(signal, Number(timeoutMs) > 0 ? Number(timeoutMs) : 180_000, 'mistral');
  try {
    const response = await fetchImpl(`${cleanBaseUrl(env.MISTRAL_BASE_URL)}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      body: form,
      signal: bounded.signal,
    });
    const headers = headersObject(response.headers);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload?.message || payload?.error?.message || payload?.detail || `Mistral HTTP ${response.status}`;
      throw httpError(response.status, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300), headers, payload);
    }
    const segments = segmentsFromMistral(payload);
    const text = String(payload?.text || '').trim() || segments.map((s) => s.text).join(' ').trim();
    return {
      provider: 'mistral',
      model: String(payload?.model || chosenModel),
      text,
      segments,
      language: forced || (payload?.language ? String(payload.language).toLowerCase().split(/[-_]/)[0] : null),
    };
  } finally {
    bounded.dispose();
  }
}

module.exports = {
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_TRANSCRIBE_MODEL,
  mistralApiKey,
  mistralTranscribeModel,
  segmentsFromMistral,
  transcribeMistralFile,
};
