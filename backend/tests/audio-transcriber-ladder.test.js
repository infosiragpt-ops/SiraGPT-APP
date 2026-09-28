'use strict';

/**
 * Audio transcription ladder — Groq rung, Meta opt-in, provider cooldown and
 * the ladder summary log line. Prod 2026-09-28: OpenAI 429 (no credits), xAI
 * rejected key, Meta 404, local whisper unreadable → every audio failed and
 * the log never said why.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audioTranscriber = require('../src/services/audio-transcriber');

function tempAudio(t, name = 'nota.ogg') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-audio-ladder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from('fake-audio'));
  return filePath;
}

function failing(status, message, code) {
  return { audio: { transcriptions: { async create() { const e = new Error(message); e.status = status; if (code) e.code = code; throw e; } } } };
}

function captureWarn(t) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.warn = original; });
  return lines;
}

test.beforeEach(() => audioTranscriber.clearTranscriptionCooldowns());
test.afterEach(() => audioTranscriber.clearTranscriptionCooldowns());

test('Groq sits right after OpenAI and speaks the OpenAI audio surface', () => {
  assert.deepEqual(audioTranscriber.providerOrder({ env: {} }), ['openai', 'groq', 'xai', 'meta', 'local']);
  const providers = audioTranscriber.cloudProviders({ env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_l1', GROQ_API_KEY: 'gsk_test' } });
  assert.deepEqual(providers.map((p) => p.name), ['openai', 'groq']);
  const groq = providers[1];
  assert.equal(groq.model, audioTranscriber.DEFAULT_GROQ_TRANSCRIBE_MODEL);
  assert.equal(groq.model, 'whisper-large-v3-turbo');
  assert.equal(groq.verbose, true);
  assert.deepEqual(audioTranscriber.cloudProviders({ env: { GROQ_API_KEY: 'gsk_test', TRANSCRIBE_GROQ_DISABLED: '1' } }).map((p) => p.name), []);
});

test('Meta is skipped unless SIRAGPT_META_TRANSCRIPTION=1 or listed explicitly', () => {
  assert.deepEqual(audioTranscriber.cloudProviders({ env: { MODEL_API_KEY: 'meta-key' } }).map((p) => p.name), []);
  assert.deepEqual(audioTranscriber.cloudProviders({ env: { MODEL_API_KEY: 'meta-key', SIRAGPT_META_TRANSCRIPTION: '1' } }).map((p) => p.name), ['meta']);
  assert.deepEqual(audioTranscriber.cloudProviders({ env: { MODEL_API_KEY: 'meta-key', TRANSCRIBE_PROVIDERS: 'meta,local' } }).map((p) => p.name), ['meta']);
  assert.equal(audioTranscriber.metaTranscriptionEnabled({ env: {} }), false);
});

test('isBillingError: 402 / insufficient_quota / billing 429, never a plain rate limit', () => {
  assert.equal(audioTranscriber.isBillingError({ status: 402 }), true);
  assert.equal(audioTranscriber.isBillingError({ status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' }), true);
  assert.equal(audioTranscriber.isBillingError({ status: 429, message: '429 no credits remaining' }), true);
  assert.equal(audioTranscriber.isBillingError({ status: 429, message: 'Rate limit reached, retry in 2s' }), false);
  assert.equal(audioTranscriber.isBillingError({ status: 500 }), false);
});

test('OpenAI without credits → Groq transcribes; the next job skips OpenAI (30 min cooldown)', async (t) => {
  const filePath = tempAudio(t);
  let openaiCalls = 0;
  const groqRequests = [];
  const options = {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_l2', GROQ_API_KEY: 'gsk_test', WHISPER_LANGUAGE: 'es' },
    createFile: (buffer, name, mime) => ({ name, mime, bytes: buffer.length }),
    openai: { audio: { transcriptions: { async create() {
      openaiCalls += 1;
      const e = new Error('429 You exceeded your current quota, please check your plan and billing details.');
      e.status = 429; e.code = 'insufficient_quota';
      throw e;
    } } } },
    groqClient: { audio: { transcriptions: { async create(request) {
      groqRequests.push(request);
      return { text: 'Hola Luis, la reunión es a las tres.', language: 'es', segments: [{ start: 0, end: 2.5, text: 'Hola Luis, la reunión es a las tres.' }] };
    } } } },
    async localTranscribe() { throw new Error('local must not run when Groq succeeds'); },
  };
  const first = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', options);
  assert.equal(first.method, 'whisper');
  assert.equal(first.model, 'whisper-large-v3-turbo');
  assert.match(first.transcript, /Hola Luis/);
  assert.equal(groqRequests[0].response_format, 'verbose_json');
  assert.deepEqual(groqRequests[0].timestamp_granularities, ['segment']);
  assert.equal(groqRequests[0].language, 'es');
  assert.equal(openaiCalls, 1);
  assert.equal(audioTranscriber.providerInCooldown({ name: 'openai', key: 'sk-proj-TESTKEY_l2' }), true);

  const second = await audioTranscriber.transcribe(tempAudio(t, 'otra.ogg'), 'audio/ogg', 'otra.ogg', options);
  assert.equal(second.method, 'whisper');
  assert.equal(openaiCalls, 1, 'OpenAI is not re-hit while in cooldown');
  assert.equal(groqRequests.length, 2);
});

test('a rejected key (403) is remembered per provider; a new key re-arms it', async (t) => {
  const filePath = tempAudio(t);
  let groqCalls = 0;
  const base = {
    env: { GROQ_API_KEY: 'gsk_dead' },
    createFile: (buffer, name, mime) => ({ name, mime }),
    groqClient: { audio: { transcriptions: { async create() { groqCalls += 1; const e = new Error('403 invalid api key'); e.status = 403; throw e; } } } },
    async localTranscribe() { return { text: 'transcripción local', model: 'base' }; },
  };
  const r1 = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', base);
  assert.equal(r1.method, 'local-whisper');
  assert.equal(groqCalls, 1);
  await audioTranscriber.transcribe(tempAudio(t, 'b.ogg'), 'audio/ogg', 'b.ogg', base);
  assert.equal(groqCalls, 1, 'cooldown skips the dead key');
  await audioTranscriber.transcribe(tempAudio(t, 'c.ogg'), 'audio/ogg', 'c.ogg', { ...base, env: { GROQ_API_KEY: 'gsk_new' } });
  assert.equal(groqCalls, 2, 'a different key is tried again');
});

test('the final log line summarises the whole ladder, including the local reason', async (t) => {
  const filePath = tempAudio(t);
  const warns = captureWarn(t);
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_l3', GROQ_API_KEY: 'gsk_test', XAI_API_KEY: 'xai-test' },
    createFile: (buffer, name, mime) => ({ name, mime }),
    openai: failing(429, '429 You exceeded your current quota; check billing', 'insufficient_quota'),
    groqClient: failing(500, '500 internal error'),
    xaiTranscribe: async () => { const e = new Error('401 Unauthorized'); e.status = 401; throw e; },
    async localTranscribe() {
      const e = new Error('local whisper unavailable: model not readable by uid 100 (/usr/local/share/whisper/ggml-base.bin)');
      e.code = 'LOCAL_WHISPER_UNAVAILABLE';
      e.reason = 'model not readable by uid 100 (/usr/local/share/whisper/ggml-base.bin)';
      throw e;
    },
  });
  assert.equal(result.method, 'placeholder');
  assert.match(result.text, /Transcripción no disponible\./, 'user-facing text stays Spanish');
  const summary = warns.find((l) => /providers tried:/.test(l));
  assert.ok(summary, 'a summary line is logged');
  assert.match(summary, /openai\(429 billing\) groq\(500\) xai\(401 key\) local\(model not readable by uid 100/);
  assert.doesNotMatch(summary, /sk-proj|gsk_test|xai-test/);
});
