'use strict';

/**
 * AssemblyAI Universal (async) transcription: upload the piece
 * (`POST /v2/upload`, raw bytes) → create the transcript (`POST /v2/transcript`)
 * → poll `GET /v2/transcript/:id` until `completed` or `error`. The best
 * published Spanish and Spanish/English code-switching accuracy of the pool,
 * speaker labels included. The engine calls it per FLAC piece like every
 * other cloud rung; the same flow would take a whole 10-hour file.
 *
 * Times come back in milliseconds and are converted to seconds. Errors carry
 * `status` and `headers` so audio-transcriber's classifiers read them as
 * they read the OpenAI SDK's. The poll interval is injectable (tests).
 */

const fs = require('fs');
const { boundedSignal, headersObject, round3 } = require('./http-shared');

const DEFAULT_ASSEMBLYAI_BASE_URL = 'https://api.assemblyai.com/v2';
const DEFAULT_POLL_MS = 2_500;
const MAX_POLL_MS = 10_000;
const MAX_POLL_FAILURES = 4;

function cleanBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  return value || DEFAULT_ASSEMBLYAI_BASE_URL;
}

function assemblyAiApiKey(env = process.env) {
  return String(env.ASSEMBLYAI_API_KEY || '').trim();
}

/** The `speech_model` sent (empty = the account's default, their newest Universal model). */
function assemblyAiSpeechModel(env = process.env) {
  return String(env.ASSEMBLYAI_SPEECH_MODEL || '').trim() || null;
}

function abortError() {
  return Object.assign(new Error('aborted by user'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function httpError(status, message, headers = null) {
  const err = new Error(message);
  err.status = status;
  err.provider = 'assemblyai';
  if (headers) err.headers = headers;
  return err;
}

function msToSec(value) {
  return round3(Number(value) / 1000);
}

/** Utterances (speaker turns) → engine segments; words → segments when there are none. */
function segmentsFromAssemblyAi(payload) {
  const timed = (item) => Number.isFinite(Number(item?.start)) && Number.isFinite(Number(item?.end));
  const utterances = Array.isArray(payload?.utterances) ? payload.utterances : [];
  if (utterances.some(timed)) {
    return utterances.filter(timed).map((u) => {
      const out = { start: msToSec(u.start), end: msToSec(u.end), text: String(u.text || '').trim() };
      if (u.speaker != null) out.speaker = String(u.speaker);
      const confidence = Number(u.confidence);
      if (Number.isFinite(confidence) && confidence > 0) out.confidence = Math.round(Math.min(1, confidence) * 1000) / 1000;
      return out;
    }).filter((s) => s.text);
  }
  const words = Array.isArray(payload?.words) ? payload.words : [];
  if (!words.some(timed)) return [];
  const out = [];
  let current = null;
  for (const word of words.filter(timed)) {
    const text = String(word.text || '').trim();
    if (!text) continue;
    const start = msToSec(word.start);
    const end = msToSec(word.end);
    const speaker = word.speaker != null ? String(word.speaker) : undefined;
    if (current && (start - current.end >= 1 || end - current.start > 12 || speaker !== current.speaker || /[.!?…]$/.test(current.text))) {
      out.push(current);
      current = null;
    }
    if (!current) current = { start, end, text, ...(speaker !== undefined ? { speaker } : {}) };
    else { current.end = end; current.text = `${current.text} ${text}`; }
  }
  if (current) out.push(current);
  return out;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function request(fetchImpl, url, init, { signal, timeoutMs }) {
  if (signal?.aborted) throw abortError();
  // A budget overrun is a TIMEOUT (transient to the engine), never an abort.
  const bounded = boundedSignal(signal, timeoutMs, 'assemblyai');
  try {
    const response = await fetchImpl(url, { ...init, signal: bounded.signal });
    const headers = headersObject(response.headers);
    const payload = await readJson(response);
    if (!response.ok) {
      const message = payload?.error || payload?.message || `AssemblyAI HTTP ${response.status}`;
      throw httpError(response.status, String(message), headers);
    }
    return payload;
  } finally {
    bounded.dispose();
  }
}

/** A poll that failed for a reason the next poll may not see (5xx, 429, network): worth another poll, not a new transcript. */
function isTransientPollError(err) {
  const status = Number(err?.status || 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status) return false;
  return /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_[A-Z_]+)$/.test(String(err?.code || '')) || /fetch failed|network/i.test(String(err?.message || ''));
}

/**
 * One piece → AssemblyAI. `language`: an ISO-639-1 code forces it; null asks
 * for detection. `keyterms` (names, jargon) go to `keyterms_prompt`.
 */
async function transcribeAssemblyAiFile({ filePath, mimeType, language, signal, timeoutMs, model, keyterms = [], env = process.env, fetchImpl = globalThis.fetch, sleep = null, pollMs = DEFAULT_POLL_MS } = {}) {
  if (!filePath) throw Object.assign(new Error('Audio file path is required for AssemblyAI STT.'), { code: 'assemblyai_audio_file_required' });
  const key = assemblyAiApiKey(env);
  if (!key) throw Object.assign(new Error('ASSEMBLYAI_API_KEY is required.'), { code: 'assemblyai_key_required', status: 401 });
  const base = cleanBaseUrl(env.ASSEMBLYAI_BASE_URL);
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 300_000;
  const startedAt = Date.now();
  const remaining = () => Math.max(1_000, budget - (Date.now() - startedAt));
  const authHeaders = { authorization: key, Accept: 'application/json' };

  const body = await fs.promises.readFile(filePath);
  const uploaded = await request(fetchImpl, `${base}/upload`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': mimeType || 'application/octet-stream' },
    body,
  }, { signal, timeoutMs: remaining() });
  const uploadUrl = uploaded?.upload_url;
  if (!uploadUrl) throw httpError(502, 'AssemblyAI upload returned no upload_url.');

  const speechModel = String(model || '').trim() || assemblyAiSpeechModel(env);
  const forced = String(language || '').trim().toLowerCase();
  const terms = (Array.isArray(keyterms) ? keyterms : []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 200);
  const createBody = {
    audio_url: uploadUrl,
    punctuate: true,
    format_text: true,
    speaker_labels: String(env.TRANSCRIBE_ASSEMBLYAI_DIARIZE || '') !== '0',
    ...(speechModel ? { speech_model: speechModel } : {}),
    ...(forced ? { language_code: forced } : { language_detection: true }),
    ...(terms.length ? { keyterms_prompt: terms } : {}),
  };
  const created = await request(fetchImpl, `${base}/transcript`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(createBody),
  }, { signal, timeoutMs: remaining() });
  const id = created?.id;
  if (!id) throw httpError(502, 'AssemblyAI returned no transcript id.');

  const wait = sleep || ((ms) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  }));
  let interval = Math.max(250, Number(pollMs) || DEFAULT_POLL_MS);
  let pollFailures = 0;
  for (;;) {
    if (Date.now() - startedAt >= budget) {
      throw Object.assign(new Error(`AssemblyAI transcript ${id} timed out after ${Math.round(budget / 1000)} s`), { code: 'ETIMEDOUT', provider: 'assemblyai' });
    }
    await wait(interval, signal);
    let status;
    try {
      status = await request(fetchImpl, `${base}/transcript/${encodeURIComponent(id)}`, { method: 'GET', headers: authHeaders }, { signal, timeoutMs: remaining() });
    } catch (err) {
      // The transcript keeps running on their side: a failed poll is polled
      // again (bounded), never a re-upload that bills a second transcript.
      if (signal?.aborted || !isTransientPollError(err) || pollFailures >= MAX_POLL_FAILURES) throw err;
      pollFailures++;
      interval = Math.min(MAX_POLL_MS, Math.round(interval * 1.5));
      continue;
    }
    const state = String(status?.status || '').toLowerCase();
    if (state === 'completed') {
      const segments = segmentsFromAssemblyAi(status);
      const text = String(status.text || '').trim() || segments.map((s) => s.text).join(' ').trim();
      const duration = Number(status.audio_duration);
      return {
        provider: 'assemblyai',
        model: speechModel || String(status.speech_model || 'universal'),
        text,
        segments,
        language: forced || (status.language_code ? String(status.language_code).toLowerCase().split('_')[0] : null),
        ...(Number.isFinite(duration) && duration > 0 ? { durationSec: round3(duration) } : {}),
      };
    }
    if (state === 'error') {
      // A transcript that failed on their side is a per-piece failure (the
      // engine demotes this piece), not a dead key.
      throw Object.assign(new Error(String(status.error || 'AssemblyAI transcription failed')), { status: 422, provider: 'assemblyai', code: 'assemblyai_transcript_error' });
    }
    interval = Math.min(MAX_POLL_MS, Math.round(interval * 1.5));
  }
}

module.exports = {
  DEFAULT_ASSEMBLYAI_BASE_URL,
  DEFAULT_POLL_MS,
  assemblyAiApiKey,
  assemblyAiSpeechModel,
  segmentsFromAssemblyAi,
  transcribeAssemblyAiFile,
};
