'use strict';

// Deepgram Nova-3 and AssemblyAI Universal adapters of the transcription
// pool: request shape (auth, parameters, body), response mapping (speakers,
// seconds, language, duration) and error surfaces the engine classifies
// (status + headers). Offline: fetch is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const deepgram = require('../src/services/stt-providers/deepgram');
const assembly = require('../src/services/stt-providers/assemblyai');

function tempFile(t, name = 'seg-0001.flac', bytes = 'flac-bytes-0001') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-stt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach(fn) { for (const [k, v] of Object.entries(headers)) fn(v, k); } },
    async json() { if (body === undefined) throw new Error('no body'); return body; },
  };
}

// ── Deepgram ────────────────────────────────────────────────────────────────

const DG_PAYLOAD = {
  metadata: { duration: 600.25, models: ['m1'], model_info: { m1: { name: 'nova-3' } } },
  results: {
    channels: [{ detected_language: 'es-419', alternatives: [{ transcript: 'Hola a todos. Empezamos la clase.', confidence: 0.98, words: [] }] }],
    utterances: [
      { start: 0.5, end: 2.1, transcript: 'Hola a todos.', speaker: 0, confidence: 0.97 },
      { start: 2.6, end: 4.0, transcript: 'Empezamos la clase.', speaker: 1, confidence: 0.91 },
    ],
  },
};

test('Deepgram: one POST /v1/listen with Token auth, diarization, utterances, opt-out, detection; speakers and language mapped', async (t) => {
  const file = tempFile(t);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return response(200, DG_PAYLOAD); };
  const out = await deepgram.transcribeDeepgramFile({ filePath: file, mimeType: 'audio/flac', language: null, timeoutMs: 90_000, env: { DEEPGRAM_API_KEY: 'dg-secret' }, fetchImpl });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('diarize'), 'true');
  assert.equal(url.searchParams.get('utterances'), 'true');
  assert.equal(url.searchParams.get('smart_format'), 'true');
  assert.equal(url.searchParams.get('mip_opt_out'), 'true');
  assert.equal(url.searchParams.get('detect_language'), 'true');
  assert.equal(url.searchParams.has('language'), false);
  assert.equal(url.searchParams.has('keyterm'), false, 'key terms are opt-in');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Token dg-secret');
  assert.equal(init.headers['Content-Type'], 'audio/flac');
  assert.ok(Buffer.isBuffer(init.body) && init.body.toString() === 'flac-bytes-0001', 'the piece travels as the raw body');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(out.provider, 'deepgram');
  assert.equal(out.model, 'nova-3');
  assert.equal(out.text, 'Hola a todos. Empezamos la clase.');
  assert.equal(out.language, 'es');
  assert.equal(out.durationSec, 600.25);
  assert.deepEqual(out.segments, [
    { start: 0.5, end: 2.1, text: 'Hola a todos.', speaker: '0', confidence: 0.97 },
    { start: 2.6, end: 4, text: 'Empezamos la clase.', speaker: '1', confidence: 0.91 },
  ]);
});

test('Deepgram: a forced language, the multi (code-switching) setting, key terms on request, words grouped when there are no utterances', async (t) => {
  const file = tempFile(t);
  const urls = [];
  const words = [
    { word: 'hola', punctuated_word: 'Hola', start: 0.1, end: 0.4, speaker: 0 },
    { word: 'a', punctuated_word: 'a', start: 0.5, end: 0.6, speaker: 0 },
    { word: 'todos', punctuated_word: 'todos.', start: 0.7, end: 1.0, speaker: 0 },
    { word: 'empezamos', punctuated_word: 'Empezamos', start: 1.2, end: 1.9, speaker: 1 },
  ];
  const payload = { results: { channels: [{ alternatives: [{ transcript: '', words }] }] } };
  const fetchImpl = async (url) => { urls.push(new URL(url)); return response(200, payload); };
  const forced = await deepgram.transcribeDeepgramFile({ filePath: file, mimeType: 'audio/flac', language: 'es', keyterms: ['Ñahui', 'SiraGPT'], env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_MODEL: 'nova-3-general' }, fetchImpl });
  assert.equal(urls[0].searchParams.get('language'), 'es');
  assert.equal(urls[0].searchParams.has('detect_language'), false);
  assert.equal(urls[0].searchParams.get('model'), 'nova-3-general');
  assert.deepEqual(urls[0].searchParams.getAll('keyterm'), ['Ñahui', 'SiraGPT']);
  assert.equal(forced.language, 'es');
  assert.deepEqual(forced.segments, [
    { start: 0.1, end: 1, text: 'Hola a todos.', speaker: '0' },
    { start: 1.2, end: 1.9, text: 'Empezamos', speaker: '1' },
  ]);
  assert.equal(forced.text, 'Hola a todos. Empezamos', 'text falls back to the grouped words');
  await deepgram.transcribeDeepgramFile({ filePath: file, mimeType: 'audio/flac', env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_LANGUAGE: 'multi', TRANSCRIBE_DEEPGRAM_DIARIZE: '0' }, fetchImpl });
  assert.equal(urls[1].searchParams.get('language'), 'multi');
  assert.equal(urls[1].searchParams.get('diarize'), 'false');
});

test('Deepgram: errors carry status and headers for the engine (429 Retry-After, 401), no key is a 401-shaped error, abort is honoured', async (t) => {
  const file = tempFile(t);
  let fetchImpl = async () => response(429, { err_code: 'TOO_MANY_REQUESTS', err_msg: 'Too many requests' }, { 'retry-after': '30' });
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k' }, fetchImpl }),
    (err) => err.status === 429 && err.headers['retry-after'] === '30' && err.code === 'TOO_MANY_REQUESTS' && /Too many requests/.test(err.message));
  fetchImpl = async () => response(401, undefined);
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k' }, fetchImpl }), (err) => err.status === 401);
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: file, env: {}, fetchImpl }), { code: 'deepgram_key_required', status: 401 });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k' }, fetchImpl, signal: ctrl.signal }), { name: 'AbortError' });
});

// ── AssemblyAI ──────────────────────────────────────────────────────────────

function assemblyServer({ pollsBeforeDone = 1, final = null, failAt = null } = {}) {
  const calls = [];
  let polls = 0;
  const completed = final || {
    id: 't1', status: 'completed', text: 'Hola a todos. Empezamos la clase.', language_code: 'es', audio_duration: 600, speech_model: 'universal-3.5-pro',
    words: [
      { text: 'Hola', start: 500, end: 900, confidence: 0.99, speaker: 'A' },
      { text: 'a', start: 950, end: 1000, confidence: 0.99, speaker: 'A' },
      { text: 'todos.', start: 1100, end: 2100, confidence: 0.98, speaker: 'A' },
      { text: 'Empezamos', start: 2600, end: 3200, confidence: 0.9, speaker: 'B' },
      { text: 'la', start: 3250, end: 3400, confidence: 0.9, speaker: 'B' },
      { text: 'clase.', start: 3450, end: 4000, confidence: 0.9, speaker: 'B' },
    ],
    utterances: [
      { speaker: 'A', start: 500, end: 2100, text: 'Hola a todos.', confidence: 0.98 },
      { speaker: 'B', start: 2600, end: 4000, text: 'Empezamos la clase.', confidence: 0.9 },
    ],
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (failAt && failAt.path === u.pathname && failAt.method === (init.method || 'GET')) return response(failAt.status, failAt.body, failAt.headers || {});
    if (u.pathname === '/v2/upload') return response(200, { upload_url: 'https://cdn.assemblyai.com/upload/abc' });
    if (u.pathname === '/v2/transcript' && init.method === 'POST') return response(200, { id: 't1', status: 'queued' });
    if (u.pathname === '/v2/transcript/t1') {
      polls++;
      if (polls <= pollsBeforeDone) return response(200, { id: 't1', status: polls === 1 ? 'queued' : 'processing' });
      return response(200, completed);
    }
    return response(404, { error: 'not found' });
  };
  return { calls, fetchImpl };
}

test('AssemblyAI: upload → create → poll; auth header, detection by default, speakers in seconds, duration, model', async (t) => {
  const file = tempFile(t);
  const server = assemblyServer({ pollsBeforeDone: 2 });
  const sleeps = [];
  const out = await assembly.transcribeAssemblyAiFile({ filePath: file, mimeType: 'audio/flac', language: null, timeoutMs: 60_000,
    env: { ASSEMBLYAI_API_KEY: 'aai-secret' }, fetchImpl: server.fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, pollMs: 1000 });
  const [upload, create, ...polls] = server.calls;
  assert.equal(upload.url.href, 'https://api.assemblyai.com/v2/upload');
  assert.equal(upload.init.method, 'POST');
  assert.equal(upload.init.headers.authorization, 'aai-secret');
  assert.equal(upload.init.headers['Content-Type'], 'audio/flac');
  assert.equal(upload.init.body.toString(), 'flac-bytes-0001');
  assert.equal(create.url.href, 'https://api.assemblyai.com/v2/transcript');
  const body = JSON.parse(create.init.body);
  assert.deepEqual(body, { audio_url: 'https://cdn.assemblyai.com/upload/abc', punctuate: true, format_text: true, speaker_labels: true, language_detection: true });
  assert.equal(polls.length, 3);
  assert.ok(polls.every((p) => p.url.pathname === '/v2/transcript/t1' && p.init.method === 'GET' && p.init.headers.authorization === 'aai-secret'));
  assert.deepEqual(sleeps, [1000, 1500, 2250], 'polling backs off gently');
  assert.equal(out.provider, 'assemblyai');
  assert.equal(out.model, 'universal-3.5-pro', 'the model the provider reports having used');
  assert.equal(out.text, 'Hola a todos. Empezamos la clase.');
  assert.equal(out.language, 'es');
  assert.equal(out.durationSec, 600);
  assert.deepEqual(out.segments, [
    { start: 0.5, end: 2.1, text: 'Hola a todos.', speaker: 'A', confidence: 0.98 },
    { start: 2.6, end: 4, text: 'Empezamos la clase.', speaker: 'B', confidence: 0.9 },
  ]);
});

test('AssemblyAI: a forced language, a configured model and key terms reach the create body; words are grouped without utterances', async (t) => {
  const file = tempFile(t);
  const final = { id: 't1', status: 'completed', text: '', language_code: 'es_us', audio_duration: 4,
    words: [
      { text: 'Hola', start: 500, end: 900, speaker: 'A' }, { text: 'a', start: 950, end: 1000, speaker: 'A' }, { text: 'todos.', start: 1100, end: 2100, speaker: 'A' },
      { text: 'Empezamos', start: 2600, end: 3200, speaker: 'B' },
    ] };
  const server = assemblyServer({ pollsBeforeDone: 0, final });
  const out = await assembly.transcribeAssemblyAiFile({ filePath: file, mimeType: 'audio/flac', language: 'es', keyterms: ['Ñahui', ''],
    env: { ASSEMBLYAI_API_KEY: 'k', ASSEMBLYAI_SPEECH_MODEL: 'universal-3.5-pro', TRANSCRIBE_ASSEMBLYAI_DIARIZE: '0' }, fetchImpl: server.fetchImpl, sleep: async () => {} });
  const body = JSON.parse(server.calls[1].init.body);
  assert.deepEqual(body, { audio_url: 'https://cdn.assemblyai.com/upload/abc', punctuate: true, format_text: true, speaker_labels: false, speech_model: 'universal-3.5-pro', language_code: 'es', keyterms_prompt: ['Ñahui'] });
  assert.equal(out.model, 'universal-3.5-pro');
  assert.equal(out.language, 'es');
  assert.deepEqual(out.segments, [
    { start: 0.5, end: 2.1, text: 'Hola a todos.', speaker: 'A' },
    { start: 2.6, end: 3.2, text: 'Empezamos', speaker: 'B' },
  ]);
  assert.equal(out.text, 'Hola a todos. Empezamos');
});

test('AssemblyAI: HTTP errors keep status + headers; a transcript that errors is a per-piece 422; a budget that runs out is a timeout; no key', async (t) => {
  const file = tempFile(t);
  let server = assemblyServer({ failAt: { path: '/v2/upload', method: 'POST', status: 429, body: { error: 'rate limited' }, headers: { 'retry-after': '12' } } });
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: server.fetchImpl, sleep: async () => {} }),
    (err) => err.status === 429 && err.headers['retry-after'] === '12' && /rate limited/.test(err.message));
  server = assemblyServer({ pollsBeforeDone: 0, final: { id: 't1', status: 'error', error: 'Audio file could not be decoded' } });
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: server.fetchImpl, sleep: async () => {} }),
    { status: 422, code: 'assemblyai_transcript_error' });
  server = assemblyServer({ pollsBeforeDone: 1_000_000 });
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, timeoutMs: 5, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: server.fetchImpl, sleep: async () => {} }),
    { code: 'ETIMEDOUT' });
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, env: {}, fetchImpl: server.fetchImpl }), { code: 'assemblyai_key_required', status: 401 });
});
