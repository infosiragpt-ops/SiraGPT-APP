'use strict';

/**
 * Deepgram Nova-3 pre-recorded transcription (`POST /v1/listen`), the fastest
 * batch engine of the pool (≈ 550× real time, 2 GB per request). The engine
 * calls it per FLAC piece like every other cloud rung. Diarization, smart
 * formatting and utterances are requested; `mip_opt_out=true` keeps the audio
 * out of Deepgram's model-improvement program (retention only for the
 * request). Errors carry `status` and `headers` so audio-transcriber's
 * classifiers (billing / rate limit / transient / segment) read them as they
 * read the OpenAI SDK's.
 */

const fs = require('fs');

const DEFAULT_DEEPGRAM_BASE_URL = 'https://api.deepgram.com/v1';
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
// Nova-3's code-switching mode: ten languages in one recording (Spanish included).
const MULTI_LANGUAGE = 'multi';

function cleanBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_DEEPGRAM_BASE_URL;
}

function deepgramApiKey(env = process.env) {
  return String(env.DEEPGRAM_API_KEY || '').trim();
}

function deepgramModel(env = process.env) {
  return String(env.DEEPGRAM_MODEL || '').trim() || DEFAULT_DEEPGRAM_MODEL;
}

function httpError(status, message, headers = null, body = null) {
  const err = new Error(message);
  err.status = status;
  err.provider = 'deepgram';
  if (headers) err.headers = headers;
  if (body && typeof body === 'object') {
    if (body.err_code) err.code = String(body.err_code);
    else if (body.error) err.code = String(body.error).slice(0, 60);
  }
  return err;
}

function headersObject(headers) {
  const out = {};
  try {
    if (headers && typeof headers.forEach === 'function') headers.forEach((value, key) => { out[String(key).toLowerCase()] = value; });
    else if (headers && typeof headers === 'object') for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value;
  } catch { /* advisory */ }
  return out;
}

function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Utterances (speaker turns) → engine segments; words → segments when there are none. */
function segmentsFromDeepgram(payload) {
  const results = payload?.results || {};
  const utterances = Array.isArray(results.utterances) ? results.utterances : [];
  const timed = (item) => Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end));
  if (utterances.some(timed)) {
    return utterances.filter(timed).map((u) => {
      const text = String(u.transcript || '').trim();
      const out = { start: round3(u.start), end: round3(u.end), text };
      if (u.speaker != null) out.speaker = String(u.speaker);
      const confidence = Number(u.confidence);
      if (Number.isFinite(confidence) && confidence > 0) out.confidence = Math.round(Math.min(1, confidence) * 1000) / 1000;
      return out;
    }).filter((s) => s.text);
  }
  const alternative = results.channels?.[0]?.alternatives?.[0];
  const words = Array.isArray(alternative?.words) ? alternative.words : [];
  if (!words.some(timed)) return [];
  // Same grouping rule as xai-audio.segmentsFromPayload: pauses ≥ 1 s,
  // sentence ends, speaker changes, a 12 s ceiling.
  const out = [];
  let current = null;
  for (const word of words.filter(timed)) {
    const text = String(word.punctuated_word || word.word || '').trim();
    if (!text) continue;
    const start = Number(word.start);
    const end = Number(word.end);
    const speaker = word.speaker != null ? String(word.speaker) : undefined;
    if (current && (start - current.end >= 1 || end - current.start > 12 || speaker !== current.speaker || /[.!?…]$/.test(current.text))) {
      out.push(current);
      current = null;
    }
    if (!current) current = { start: round3(start), end: round3(end), text, ...(speaker !== undefined ? { speaker } : {}) };
    else { current.end = round3(end); current.text = `${current.text} ${text}`; }
  }
  if (current) out.push(current);
  return out;
}

function transcriptFromDeepgram(payload, segments) {
  const alternative = payload?.results?.channels?.[0]?.alternatives?.[0];
  const transcript = String(alternative?.transcript || '').trim();
  if (transcript) return transcript;
  return segments.map((s) => s.text).join(' ').trim();
}

function detectedLanguage(payload) {
  const channel = payload?.results?.channels?.[0];
  const code = channel?.detected_language || channel?.alternatives?.[0]?.languages?.[0];
  return code ? String(code).toLowerCase().split('-')[0] : null;
}

/**
 * One piece → Deepgram. `language`: an ISO-639-1 code forces it; null asks
 * for detection (`detect_language=true`) unless DEEPGRAM_LANGUAGE says
 * otherwise (e.g. `multi` for code-switching).
 */
async function transcribeDeepgramFile({ filePath, mimeType, language, signal, timeoutMs, model, keyterms = [], env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!filePath) throw Object.assign(new Error('Audio file path is required for Deepgram STT.'), { code: 'deepgram_audio_file_required' });
  const key = deepgramApiKey(env);
  if (!key) throw Object.assign(new Error('DEEPGRAM_API_KEY is required.'), { code: 'deepgram_key_required', status: 401 });
  const chosenModel = String(model || '').trim() || deepgramModel(env);
  const params = new URLSearchParams();
  params.set('model', chosenModel);
  params.set('smart_format', 'true');
  params.set('punctuate', 'true');
  params.set('diarize', String(env.TRANSCRIBE_DEEPGRAM_DIARIZE || '') !== '0' ? 'true' : 'false');
  params.set('utterances', 'true');
  params.set('mip_opt_out', 'true');
  const forced = String(language || '').trim().toLowerCase();
  const configured = String(env.DEEPGRAM_LANGUAGE || '').trim().toLowerCase();
  if (forced) params.set('language', forced);
  else if (configured) params.set('language', configured === 'multi' ? MULTI_LANGUAGE : configured);
  else params.set('detect_language', 'true');
  for (const term of Array.isArray(keyterms) ? keyterms.slice(0, 100) : []) {
    const value = String(term || '').trim();
    if (value) params.append('keyterm', value);
  }
  const url = `${cleanBaseUrl(env.DEEPGRAM_BASE_URL)}/listen?${params.toString()}`;
  const body = await fs.promises.readFile(filePath);
  if (signal?.aborted) throw Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' });
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 120_000;
  const signals = [AbortSignal.timeout(budget)];
  if (signal) signals.push(signal);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': mimeType || 'audio/flac', Accept: 'application/json' },
    body,
    signal: AbortSignal.any(signals),
  });
  const headers = headersObject(response.headers);
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const message = payload?.err_msg || payload?.message || payload?.error || `Deepgram HTTP ${response.status}`;
    throw httpError(response.status, String(message), headers, payload);
  }
  const segments = segmentsFromDeepgram(payload);
  const text = transcriptFromDeepgram(payload, segments);
  const duration = Number(payload?.metadata?.duration);
  return {
    provider: 'deepgram',
    model: payload?.metadata?.models?.length && payload?.metadata?.model_info
      ? (Object.values(payload.metadata.model_info)[0]?.name || chosenModel)
      : chosenModel,
    text,
    segments,
    language: forced || detectedLanguage(payload),
    ...(Number.isFinite(duration) && duration > 0 ? { durationSec: round3(duration) } : {}),
  };
}

module.exports = {
  DEFAULT_DEEPGRAM_BASE_URL,
  DEFAULT_DEEPGRAM_MODEL,
  deepgramApiKey,
  deepgramModel,
  segmentsFromDeepgram,
  transcribeDeepgramFile,
};
