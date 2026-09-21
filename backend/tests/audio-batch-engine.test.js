'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const audio = require('../src/services/audio-transcriber');
const local = require('../src/services/local-whisper-engine');

function fixture(t, name = 'nota.wav', bytes = Buffer.from('test-audio')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-batch-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('fifty concurrent audios retain their own results and never exceed two STT workers', async (t) => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const opts = {
    env: {}, durationSeconds: 1,
    async localTranscribe(file) {
      peak = Math.max(peak, ++active);
      await tick();
      const text = path.basename(file);
      completed.push(text);
      active--;
      return { text };
    },
  };
  const files = Array.from({ length: 50 }, (_, i) => fixture(t, `nota-${i}.wav`));
  const results = await Promise.all(files.map((file) => audio.transcribe(file, 'audio/wav', path.basename(file), opts)));
  assert.equal(peak, 2);
  assert.equal(completed.length, 50);
  assert.deepEqual(results.map((r) => r.transcript), files.map((file) => path.basename(file)));
  assert.ok(results.every((r) => r.ok && r.status === 'ready'));
});

test('legacy upload callers share one in-flight transcription but do not permanently cache failures', async (t) => {
  const file = fixture(t);
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const opts = {
    env: {}, durationSeconds: 1,
    async localTranscribe() { calls++; await waiting; return { text: 'Hola' }; },
  };
  const requests = Array.from({ length: 8 }, () => audio.transcribe(file, 'audio/wav', 'nota.wav', opts));
  // stat calls are asynchronous; let every caller join the same operation.
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
  release();
  const results = await Promise.all(requests);
  assert.ok(results.every((r) => r.transcript === 'Hola'));
  await audio.transcribe(file, 'audio/wav', 'nota.wav', opts);
  assert.equal(calls, 2, 'completed jobs are owned by durable File state, not a stale engine cache');
});

test('a queued cancellation does not invoke STT or block subsequent files', async (t) => {
  let release;
  let running = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const opts = { env: {}, durationSeconds: 1, async localTranscribe() { running++; await waiting; return { text: 'Listo' }; } };
  const first = audio.transcribe(fixture(t, 'primero.wav'), 'audio/wav', 'primero.wav', opts);
  const second = audio.transcribe(fixture(t, 'segundo.wav'), 'audio/wav', 'segundo.wav', opts);
  while (running < 2) await tick();
  const controller = new AbortController();
  const queued = audio.transcribe(fixture(t, 'cancelado.wav'), 'audio/wav', 'cancelado.wav', { ...opts, signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  release();
  await Promise.all([first, second]);
  assert.equal(running, 2);
  await audio.transcribe(fixture(t, 'ultimo.wav'), 'audio/wav', 'ultimo.wav', opts);
  assert.equal(running, 3);
});

test('short valid cloud and local speech is accepted, silence and empty files are not success', async (t) => {
  const file = fixture(t);
  const cloud = await audio.transcribe(file, 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 1, createFile: () => ({}),
    openai: { audio: { transcriptions: { async create() { return { text: 'Sí' }; } } } },
  });
  assert.equal(cloud.transcript, 'Sí');
  const speech = await audio.transcribe(file, 'audio/wav', 'nota.wav', { env: {}, durationSeconds: 1, localTranscribe: async () => ({ text: 'No' }) });
  assert.equal(speech.status, 'ready');
  const silence = await audio.transcribe(file, 'audio/wav', 'nota.wav', { env: {}, durationSeconds: 1, localTranscribe: async () => ({ text: '' }) });
  assert.equal(silence.ok, false);
  assert.equal(silence.reasonCode, 'no_speech');
  const empty = await audio.transcribe(fixture(t, 'empty.wav', Buffer.alloc(0)), 'audio/wav', 'empty.wav', { env: {}, durationSeconds: 0 });
  assert.equal(empty.reasonCode, 'file_empty');
  assert.equal(empty.ok, false);
});

test('real whisper non-speech markers never become successful transcription evidence', async (t) => {
  const file = fixture(t);
  for (const text of ['[MÚSICA]', '[BLANK_AUDIO]', '(silencio)', '[Music]\n[Applause]', '<|nospeech|>']) {
    const result = await audio.transcribe(file, 'audio/wav', 'nota.wav', {
      env: {}, durationSeconds: 1, localTranscribe: async () => ({ text }),
    });
    assert.equal(result.ok, false, text);
    assert.equal(result.reasonCode, 'no_speech', text);
  }
  const spoken = await audio.transcribe(file, 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 1, localTranscribe: async () => ({ text: '[MÚSICA] Hola' }),
  });
  assert.equal(spoken.transcript, '[MÚSICA] Hola');
});

test('a long compressed file under the byte cap is segmented by duration, with ordered timestamps', async (t) => {
  const file = fixture(t, 'clase.m4a');
  let calls = 0;
  let segmentations = 0;
  const segDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-engine-parts-'));
  const segments = [0, 1].map((index) => {
    const segmentPath = path.join(segDir, `part-${index}.mp3`);
    fs.writeFileSync(segmentPath, 'small-segment');
    return { path: segmentPath, index, offsetSeconds: 600 * index };
  });
  t.after(() => fs.rmSync(segDir, { recursive: true, force: true }));
  const result = await audio.transcribe(file, 'audio/mp4', 'clase.m4a', {
    env: {}, durationSeconds: 1200,
    async segmentAudio() { segmentations++; return { dir: segDir, segments }; },
    createFile: (_, name) => ({ name }),
    openai: { audio: { transcriptions: { async create() {
      calls++;
      return { text: `Parte ${calls}`, segments: [{ start: 2, end: 5, text: `Parte ${calls}` }] };
    } } } },
  });
  assert.equal(calls, 2);
  assert.equal(segmentations, 1);
  assert.equal(result.transcript, 'Parte 1\n\nParte 2');
  assert.deepEqual(result.segments.map((s) => s.start), [2, 602]);
  assert.equal(fs.existsSync(segDir), false, 'temporary chunks cleaned after success');
});

test('local long files use bounded segments and discard incomplete results on a failed part', async (t) => {
  const file = fixture(t);
  const segDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-engine-local-parts-'));
  t.after(() => fs.rmSync(segDir, { recursive: true, force: true }));
  let calls = 0;
  const result = await audio.transcribe(file, 'audio/wav', 'nota.wav', {
    env: {}, durationSeconds: 1200,
    segmentAudio: async () => ({ dir: segDir, segments: [{ path: file, index: 0, offsetSeconds: 0 }, { path: file, index: 1, offsetSeconds: 600 }] }),
    async localTranscribe() {
      if (++calls === 2) throw new Error('worker unavailable');
      return { text: 'Only a partial result' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.transcript, undefined);
  assert.equal(fs.existsSync(segDir), false);
});

test('ffmpeg segmentation abort kills the process, removes temporary files, and excludes secrets', async (t) => {
  const file = fixture(t);
  const controller = new AbortController();
  let dir;
  let killed;
  let childEnv;
  const operation = audio.segmentForCloud(file, {
    signal: controller.signal,
    spawnImpl(_bin, args, options) {
      dir = path.dirname(args.at(-1));
      childEnv = options.env;
      fs.writeFileSync(path.join(dir, 'partial.mp3'), 'partial');
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => { killed = signal; };
      queueMicrotask(() => controller.abort());
      return child;
    },
  });
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(killed, 'SIGKILL');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
});

test('failed ffmpeg startup cleans the created segment directory', async (t) => {
  const file = fixture(t);
  let dir;
  await assert.rejects(audio.segmentForCloud(file, {
    spawnImpl(_bin, args) { dir = path.dirname(args.at(-1)); throw new Error('cannot start'); },
  }), /cannot start/);
  assert.equal(fs.existsSync(dir), false);
});

test('whisper.cpp JSON offsets and timestamp strings become real subtitle timestamps', () => {
  const result = local.parseWhisperCppJson(JSON.stringify({ transcription: [
    { offsets: { from: 1200, to: 2600 }, text: 'Hola' },
    { timestamps: { from: '00:01:03,250', to: '00:01:04.750' }, text: 'Mundo' },
  ] }));
  assert.deepEqual(result.segments, [{ start: 1.2, end: 2.6, text: 'Hola' }, { start: 63.25, end: 64.75, text: 'Mundo' }]);
  assert.match(audio.buildSrt(result.segments), /00:01:03,250 --> 00:01:04,750/);
});

test('common media extensions and declared audio types use transcription, not opaque-file extraction', () => {
  for (const ext of ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac', 'aiff', 'caf', 'mp4', 'mov', 'mkv', 'avi']) {
    assert.equal(audio.isAudioMedia('application/octet-stream', `nota.${ext}`), true, ext);
  }
  assert.equal(audio.isAudioMedia('audio/x-vendor-format', 'nota.bin'), true);
  assert.equal(audio.isAudioMedia('text/typescript', 'source.ts'), false);
});

test('xAI STT receives the cancellation signal and closes its file stream', async (t) => {
  const xai = require('../src/services/xai-audio');
  const file = fixture(t);
  const controller = new AbortController();
  let requestSignal;
  const result = await xai.transcribeXaiAudioFile({
    filePath: file, originalName: 'nota.wav', mimeType: 'audio/wav', signal: controller.signal,
    env: { XAI_API_KEY: 'test-only-key' },
    axiosImpl: { async post(_url, form, options) {
      requestSignal = options.signal;
      assert.ok(form.getHeaders()['content-type'].startsWith('multipart/form-data'));
      return { data: { text: 'Hola' } };
    } },
  });
  assert.equal(requestSignal, controller.signal);
  assert.equal(result.text, 'Hola');
});
