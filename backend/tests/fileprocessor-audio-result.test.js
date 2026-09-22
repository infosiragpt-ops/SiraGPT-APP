'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const processor = require('../src/services/fileProcessor');

function recording(t, name = 'nota.wav', mime = 'audio/wav') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-audio-result-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  // A real PCM WAV container, not an external audio upload or paid STT call.
  const samples = 1600;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, originalname: name, mimetype: mime, size: bytes.length };
}

test('audio extraction retains transcript metadata and propagates progress/signal', async (t) => {
  const file = recording(t);
  const signal = new AbortController().signal;
  const events = [];
  const result = await processor.processFile(file, {
    env: {}, durationSeconds: 1, signal, onProgress: (event) => events.push(event),
    async localTranscribe(filePath, options) {
      assert.equal(filePath, file.path);
      assert.equal(options.signal, signal);
      assert.equal(fs.readFileSync(filePath).subarray(0, 4).toString(), 'RIFF');
      options.onProgress({ stage: 'transcribe', completed: 1, total: 1 });
      return { text: 'Hola', segments: [{ start: 0, end: 1, text: 'Hola' }] };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.transcription.transcript, 'Hola');
  assert.equal(result.transcription.status, 'ready');
  assert.match(result.extractedText, /Hola/);
  assert.equal(events.length, 1);
});

test('silence and decoder failure never persist error placeholders as extracted speech', async (t) => {
  const file = recording(t);
  const silence = await processor.processFile(file, { env: {}, durationSeconds: 1, localTranscribe: async () => ({ text: '' }) });
  assert.equal(silence.success, false);
  assert.equal(silence.code, 'no_speech');
  assert.equal(silence.extractedText, '');
  const broken = await processor.processFile(file, {
    env: {}, durationSeconds: 1,
    localTranscribe: async () => { throw Object.assign(new Error('untrusted provider details'), { code: 'AUDIO_DECODE_FAILED' }); },
  });
  assert.equal(broken.success, false);
  assert.equal(broken.code, 'audio_decode_failed');
  assert.equal(broken.extractedText, '');
  assert.doesNotMatch(broken.error, /untrusted provider details/);
});

test('cancelled extraction throws instead of reporting success or storing a placeholder', async (t) => {
  const file = recording(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(processor.processFile(file, { env: {}, durationSeconds: 1, signal: controller.signal }), { name: 'AbortError' });
});

test('MP4 audio and generic FLAC uploads reach the same STT pipeline', async (t) => {
  for (const [name, mime] of [['nota.mp4', 'video/mp4'], ['nota.flac', 'application/octet-stream']]) {
    const file = recording(t, name, mime);
    let transcribed = false;
    const result = await processor.processFile(file, {
      env: {}, durationSeconds: 1,
      async localTranscribe(filePath) { assert.equal(filePath, file.path); transcribed = true; return { text: 'Audio leído' }; },
    });
    assert.equal(transcribed, true, name);
    assert.equal(result.success, true);
    assert.equal(result.transcription.transcript, 'Audio leído');
  }
});
