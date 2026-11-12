'use strict';

// Deepgram Nova-3, AssemblyAI Universal and Mistral Voxtral adapters of the
// transcription pool: request shape (auth, parameters, body), response
// mapping (speakers, seconds, language, duration), error surfaces the engine
// classifies (status + headers) and the shared request bound (a budget
// overrun is a TIMEOUT, never the user's abort). Offline: fetch is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const deepgram = require('../src/services/stt-providers/deepgram');
const assembly = require('../src/services/stt-providers/assemblyai');
const mistral = require('../src/services/stt-providers/mistral');
const { boundedSignal } = require('../src/services/stt-providers/http-shared');

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

test('Deepgram: the reported language is the forced one, else DEEPGRAM_LANGUAGE (unless multi), else the detected one', async (t) => {
  const file = tempFile(t);
  const payload = { results: { channels: [{ detected_language: 'pt-BR', alternatives: [{ transcript: 'Olá a todos.', words: [] }] }] } };
  const fetchImpl = async () => response(200, payload);
  assert.equal((await deepgram.transcribeDeepgramFile({ filePath: file, language: 'es', env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_LANGUAGE: 'en' }, fetchImpl })).language, 'es');
  assert.equal((await deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_LANGUAGE: 'en-US' }, fetchImpl })).language, 'en');
  assert.equal((await deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k', DEEPGRAM_LANGUAGE: 'multi' }, fetchImpl })).language, 'pt');
  assert.equal((await deepgram.transcribeDeepgramFile({ filePath: file, env: { DEEPGRAM_API_KEY: 'k' }, fetchImpl })).language, 'pt');
});

test('AssemblyAI: a poll that fails transiently (503) is polled again with backoff — never a second upload; too many failed polls surface the error', async (t) => {
  const file = tempFile(t);
  const server = assemblyServer({ pollsBeforeDone: 0 });
  let failures = 0;
  const flaky = async (url, init) => {
    if (new URL(url).pathname === '/v2/transcript/t1' && failures < 2) { failures++; return response(503, { error: 'upstream' }); }
    return server.fetchImpl(url, init);
  };
  const sleeps = [];
  const out = await assembly.transcribeAssemblyAiFile({ filePath: file, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: flaky, sleep: async (ms) => { sleeps.push(ms); }, pollMs: 1000 });
  assert.equal(out.text, 'Hola a todos. Empezamos la clase.');
  assert.equal(server.calls.filter((c) => c.url.pathname === '/v2/upload').length, 1, 'one upload');
  assert.equal(server.calls.filter((c) => c.url.pathname === '/v2/transcript' && c.init.method === 'POST').length, 1, 'one transcript (a second one would bill twice)');
  assert.deepEqual(sleeps, [1000, 1500, 2250], 'the interval backs off after each failed poll');
  const dead = async (url, init) => (new URL(url).pathname === '/v2/transcript/t1' ? response(503, { error: 'down' }) : server.fetchImpl(url, init));
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: dead, sleep: async () => {}, pollMs: 1000 }), { status: 503 });
});

// ── Mistral Voxtral ─────────────────────────────────────────────────────────

test('Mistral Voxtral: multipart as Mistral documents it (model, file, language, ONE timestamp_granularities field, diarize opt-in), Bearer auth; segments in seconds; errors keep status + headers', async (t) => {
  const file = tempFile(t, 'seg-0002.flac', 'flac-bytes-0002');
  const calls = [];
  const payload = { model: 'voxtral-mini-2507', text: 'Hola a todos. Empezamos la clase.', language: 'es', segments: [{ text: 'Hola a todos.', start: 0.5, end: 2.1 }, { text: 'Empezamos la clase.', start: 2.6, end: 4 }] };
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), init }); return response(200, payload); };
  const out = await mistral.transcribeMistralFile({ filePath: file, mimeType: 'audio/flac', fileName: 'seg-0002.flac', language: 'es', timeoutMs: 60_000, env: { MISTRAL_API_KEY: 'mi-secret' }, fetchImpl });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.mistral.ai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer mi-secret');
  assert.ok(init.body instanceof FormData, 'multipart, not JSON');
  assert.equal(init.body.get('model'), 'voxtral-mini-latest');
  assert.equal(init.body.get('language'), 'es');
  assert.deepEqual(init.body.getAll('timestamp_granularities'), ['segment'], 'one field per granularity (the OpenAI SDK would send timestamp_granularities[])');
  assert.equal(init.body.has('diarize'), false);
  assert.equal(init.body.has('prompt'), false);
  const blob = init.body.get('file');
  assert.equal(blob.name, 'seg-0002.flac');
  assert.equal(blob.type, 'audio/flac');
  assert.equal(await blob.text(), 'flac-bytes-0002');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(out.provider, 'mistral');
  assert.equal(out.model, 'voxtral-mini-2507');
  assert.equal(out.language, 'es');
  assert.equal(out.text, 'Hola a todos. Empezamos la clase.');
  assert.deepEqual(out.segments, [{ start: 0.5, end: 2.1, text: 'Hola a todos.' }, { start: 2.6, end: 4, text: 'Empezamos la clase.' }]);
  // Detection + speakers on request, a custom base URL and model.
  const detected = await mistral.transcribeMistralFile({ filePath: file, diarize: true, env: { MISTRAL_API_KEY: 'k', MISTRAL_BASE_URL: 'https://proxy.example/v1/', MISTRAL_TRANSCRIBE_MODEL: 'voxtral-mini-2507' }, fetchImpl });
  assert.equal(calls[1].url, 'https://proxy.example/v1/audio/transcriptions');
  assert.equal(calls[1].init.body.get('model'), 'voxtral-mini-2507');
  assert.equal(calls[1].init.body.has('language'), false);
  assert.equal(calls[1].init.body.get('diarize'), 'true');
  assert.equal(detected.language, 'es');
  const limited = async () => response(429, { message: 'Rate limit exceeded', type: 'rate_limited' }, { 'retry-after': '20' });
  await assert.rejects(mistral.transcribeMistralFile({ filePath: file, env: { MISTRAL_API_KEY: 'k' }, fetchImpl: limited }),
    (err) => err.status === 429 && err.headers['retry-after'] === '20' && err.code === 'rate_limited' && /Rate limit exceeded/.test(err.message));
  await assert.rejects(mistral.transcribeMistralFile({ filePath: file, env: {}, fetchImpl }), { code: 'mistral_key_required', status: 401 });
  assert.equal(mistral.mistralTranscribeModel({}), 'voxtral-mini-latest');
});

// ── the shared request bound ────────────────────────────────────────────────

test('a request that outlives its budget fails as a TIMEOUT (ETIMEDOUT, no «aborted» wording) on every adapter; the user\'s own abort stays an AbortError', async (t) => {
  const file = tempFile(t);
  // A fetch that settles only when its signal aborts, with the signal's reason — as undici does.
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) { reject(init.signal.reason); return; }
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const isTimeout = (err) => err.code === 'ETIMEDOUT' && err.name !== 'AbortError' && !/abort/i.test(err.message);
  // The bound's timer is unref'd (a real request keeps the loop alive; this fake does not): hold the loop open for the test.
  const keepAlive = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: file, timeoutMs: 5, env: { DEEPGRAM_API_KEY: 'k' }, fetchImpl: hanging }), isTimeout);
  await assert.rejects(mistral.transcribeMistralFile({ filePath: file, timeoutMs: 5, env: { MISTRAL_API_KEY: 'k' }, fetchImpl: hanging }), isTimeout);
  // AssemblyAI gives every HTTP step at least 1 s of its budget.
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: file, timeoutMs: 5, env: { ASSEMBLYAI_API_KEY: 'k' }, fetchImpl: hanging, sleep: async () => {} }), isTimeout);
  const ctrl = new AbortController();
  const pending = assert.rejects(mistral.transcribeMistralFile({ filePath: file, timeoutMs: 60_000, env: { MISTRAL_API_KEY: 'k' }, fetchImpl: hanging, signal: ctrl.signal }), { name: 'AbortError' });
  ctrl.abort();
  await pending;
  const bound = boundedSignal(null, 1, 'x');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(bound.timedOut(), true);
  assert.equal(bound.signal.reason.code, 'ETIMEDOUT');
  bound.dispose();
  const user = new AbortController();
  const forwarded = boundedSignal(user.signal, 60_000, 'y');
  user.abort();
  assert.equal(forwarded.signal.aborted, true);
  assert.equal(forwarded.timedOut(), false);
  forwarded.dispose();
});

test('word-grouping confidence averaging, AssemblyAI speakers_expected/disfluencies hints, and pre-read abort before disk I/O', async (t) => {
  const dgSegs = deepgram.segmentsFromDeepgram({
    results: {
      channels: [{
        alternatives: [{
          words: [
            { word: 'hola', punctuated_word: 'Hola', start: 0, end: 0.4, speaker: 0, confidence: 0.9 },
            { word: 'equipo', punctuated_word: 'equipo.', start: 0.5, end: 0.9, speaker: 0, confidence: 0.7 },
          ],
        }],
      }],
    },
  });
  assert.equal(dgSegs.length, 1);
  assert.equal(dgSegs[0].confidence, 0.8);

  const aaiSegs = assembly.segmentsFromAssemblyAi({
    words: [
      { text: 'Buenos', start: 0, end: 400, speaker: 'A', confidence: 0.95 },
      { text: 'días.', start: 450, end: 900, speaker: 'A', confidence: 0.85 },
    ],
  });
  assert.equal(aaiSegs.length, 1);
  assert.equal(aaiSegs[0].confidence, 0.9);

  const file = tempFile(t);
  const server = assemblyServer({ pollsBeforeDone: 0 });
  await assembly.transcribeAssemblyAiFile({
    filePath: file,
    speakersExpected: 3,
    disfluencies: true,
    env: { ASSEMBLYAI_API_KEY: 'k' },
    fetchImpl: server.fetchImpl,
    sleep: async () => {},
  });
  const createCall = server.calls.find((c) => c.url.pathname === '/v2/transcript' && c.init.method === 'POST');
  const createJson = JSON.parse(createCall.init.body);
  assert.equal(createJson.speakers_expected, 3);
  assert.equal(createJson.disfluencies, true);

  // Pre-aborted signal throws AbortError immediately without reading a missing file path.
  const preAborted = new AbortController();
  preAborted.abort();
  const missingPath = '/tmp/siragpt-nonexistent-preaborted-audio.flac';
  await assert.rejects(mistral.transcribeMistralFile({ filePath: missingPath, signal: preAborted.signal, env: { MISTRAL_API_KEY: 'k' } }), { name: 'AbortError' });
  await assert.rejects(deepgram.transcribeDeepgramFile({ filePath: missingPath, signal: preAborted.signal, env: { DEEPGRAM_API_KEY: 'k' } }), { name: 'AbortError' });
  await assert.rejects(assembly.transcribeAssemblyAiFile({ filePath: missingPath, signal: preAborted.signal, env: { ASSEMBLYAI_API_KEY: 'k' } }), { name: 'AbortError' });
});
