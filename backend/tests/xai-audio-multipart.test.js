'use strict';

/**
 * xAI STT contract: text fields go BEFORE the file part, a long segment gets
 * a timeout scaled to its length, a detection job does not inherit the TTS
 * language, and timed segments/words in the payload survive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const xai = require('../src/services/xai-audio');
const audio = require('../src/services/audio-transcriber');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-xai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'segment-1.flac');
  fs.writeFileSync(file, 'flac');
  return file;
}

/** Field names in the order form-data will write them. */
function fieldOrder(form) {
  return form._streams
    .filter((part) => typeof part === 'string' && part.includes('Content-Disposition'))
    .map((part) => /name="([^"]+)"/.exec(part)[1]);
}

function capture(data = { text: 'Hola' }) {
  const seen = {};
  return {
    seen,
    axiosImpl: { async post(url, form, options) { seen.url = url; seen.fields = fieldOrder(form); seen.options = options; return { data }; } },
  };
}

test('model and language are sent before the file part', async (t) => {
  const { seen, axiosImpl } = capture();
  await xai.transcribeXaiAudioFile({ filePath: fixture(t), mimeType: 'audio/flac', language: 'es', env: { XAI_API_KEY: 'xai-test' }, axiosImpl });
  assert.deepEqual(seen.fields, ['model', 'language', 'file']);
  assert.match(seen.url, /\/stt$/);
});

test('timeout: explicit per-request value, else XAI_AUDIO_TIMEOUT_MS / 45 s', async (t) => {
  const a = capture();
  await xai.transcribeXaiAudioFile({ filePath: fixture(t), timeoutMs: 180_000, env: { XAI_API_KEY: 'xai-test' }, axiosImpl: a.axiosImpl });
  assert.equal(a.seen.options.timeout, 180_000);
  const b = capture();
  await xai.transcribeXaiAudioFile({ filePath: fixture(t), env: { XAI_API_KEY: 'xai-test' }, axiosImpl: b.axiosImpl });
  assert.equal(b.seen.options.timeout, 45_000);
});

test('a detection job sends no language; plain callers keep the TTS-language default', async (t) => {
  const a = capture();
  await xai.transcribeXaiAudioFile({ filePath: fixture(t), detectLanguage: true, env: { XAI_API_KEY: 'xai-test' }, axiosImpl: a.axiosImpl });
  assert.deepEqual(a.seen.fields, ['model', 'file']);
  const b = capture();
  await xai.transcribeXaiAudioFile({ filePath: fixture(t), env: { XAI_API_KEY: 'xai-test' }, axiosImpl: b.axiosImpl });
  assert.deepEqual(b.seen.fields, ['model', 'language', 'file']);
});

test('timed segments and words in the payload become segments', async (t) => {
  const withSegments = capture({ text: 'Hola. Buenas.', language: 'es', segments: [{ start: 0, end: 1.5, text: 'Hola.' }, { start: 1.5, end: 3, text: 'Buenas.', speaker: 1 }] });
  const out = await xai.transcribeXaiAudioFile({ filePath: fixture(t), env: { XAI_API_KEY: 'xai-test' }, axiosImpl: withSegments.axiosImpl });
  assert.equal(out.language, 'es');
  assert.deepEqual(out.segments, [{ start: 0, end: 1.5, text: 'Hola.' }, { start: 1.5, end: 3, text: 'Buenas.', speaker: '1' }]);
  assert.deepEqual(xai.segmentsFromPayload({ words: [
    { word: 'Hola', start: 0, end: 0.4 }, { word: 'clase.', start: 0.4, end: 0.9 },
    { word: 'Hoy', start: 1.0, end: 1.2 }, { word: 'vemos', start: 1.2, end: 1.5 },
    { word: 'Pareto', start: 3.0, end: 3.4 },
  ] }), [
    { start: 0, end: 0.9, text: 'Hola clase.' },
    { start: 1.0, end: 1.5, text: 'Hoy vemos' },
    { start: 3.0, end: 3.4, text: 'Pareto' },
  ]);
  assert.deepEqual(xai.segmentsFromPayload({ text: 'sin tiempos' }), []);
});

test('the engine gives an xAI segment a timeout scaled to its length and keeps its timestamps', async (t) => {
  audio.clearTranscriptionCooldowns();
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-xai-seg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const media = path.join(dir, 'clase.mp4');
  fs.writeFileSync(media, 'video');
  const segments = [0, 1].map((i) => {
    const p = path.join(dir, `seg-000${i}.flac`);
    fs.writeFileSync(p, 'flac');
    return { path: p, index: i, offsetSeconds: i * 600, durationSeconds: 600 };
  });
  const result = await audio.transcribe(media, 'video/mp4', 'clase.mp4', {
    env: { XAI_API_KEY: 'xai-test' }, language: 'es', durationSeconds: 1200,
    segmentAudio: async () => ({ dir: null, segments }),
    async xaiTranscribe(_file, mime, name, language, _prompt, extra = {}) {
      calls.push({ mime, name, language, timeoutMs: extra.timeoutMs, signal: Boolean(extra.signal) });
      return { text: `parte ${calls.length}`, model: 'grok-stt', segments: [{ start: 2, end: 4, text: `parte ${calls.length}` }] };
    },
    async localTranscribe() { throw new Error('no local'); },
  });
  assert.deepEqual(calls.map((c) => c.timeoutMs), [180_000, 180_000], '60 s + 0.2 × 600 s');
  assert.ok(calls.every((c) => c.mime === 'audio/flac' && c.language === 'es' && c.signal));
  assert.deepEqual(result.segments.map((s) => s.start), [2, 602]);
  assert.deepEqual(result.providers, { xai: 2 });
});
