'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audioTranscriber = require('../src/services/audio-transcriber');

function tempAudio(t, name = 'note.ogg') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from('fake-whatsapp-ptt'));
  return filePath;
}

test('ogg / opus / application-ogg mimes are accepted', () => {
  assert.equal(audioTranscriber.normalizeAudioMime('audio/ogg; codecs=opus', 'ptt.ogg'), 'audio/ogg');
  assert.equal(audioTranscriber.normalizeAudioMime('audio/opus', 'note.opus'), 'audio/opus');
  assert.equal(audioTranscriber.normalizeAudioMime('application/ogg', 'voice.ogg'), 'application/ogg');
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['audio/ogg']);
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['audio/opus']);
  assert.ok(audioTranscriber.AUDIO_MIME_MAP['application/ogg']);
});

test('no language is forced without an explicit one (WHISPER_LANGUAGE only locks long jobs)', () => {
  const env = { ...process.env };
  delete env.WHISPER_LANGUAGE;
  assert.equal(audioTranscriber.resolveLanguage({ env }), undefined);
  assert.equal(audioTranscriber.resolveLanguage({ env: { WHISPER_LANGUAGE: 'es' }, durationSeconds: 20 }), undefined);
  assert.equal(audioTranscriber.resolveLanguage({ env, language: 'es-PE' }), 'es');
});

test('no OPENAI_API_KEY uses the local path, not a missing-key placeholder', async (t) => {
  const filePath = tempAudio(t);
  let localCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { WHISPER_LANGUAGE: 'es' },
    async localTranscribe() {
      localCalls += 1;
      return { text: 'Hola Luis, te llamo al almuerzo.', model: 'base', language: 'es', segments: [] };
    },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.method, 'local-whisper');
  assert.match(result.transcript, /Hola Luis/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY|placeholder-for-missing-key|Set OPENAI/);
});

test('OpenAI 401 falls back to local and never leaks sk-proj or the 401 body', async (t) => {
  const filePath = tempAudio(t);
  const fakeKeyShape = 'sk-proj-TESTKEY_x1';
  let localCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { OPENAI_API_KEY: fakeKeyShape, WHISPER_LANGUAGE: 'es' },
    openai: {
      audio: {
        transcriptions: {
          async create() {
            const err = new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
            err.status = 401;
            err.code = 'invalid_api_key';
            throw err;
          },
        },
      },
    },
    async localTranscribe() {
      localCalls += 1;
      return { text: 'Mensaje de voz transcrito en local.', model: 'base', language: 'es' };
    },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.method, 'local-whisper');
  assert.doesNotMatch(result.text, /sk-proj/);
  assert.doesNotMatch(result.text, /401 Incorrect API key/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY/);
});

test('when local also fails the placeholder is Spanish and secret-safe', async (t) => {
  const filePath = tempAudio(t);
  const fakeKeyShape = 'sk-proj-TESTKEY_y1';
  const result = await audioTranscriber.transcribe(filePath, 'audio/opus', 'ptt.opus', {
    env: { OPENAI_API_KEY: fakeKeyShape },
    openai: {
      audio: {
        transcriptions: {
          async create() {
            const err = new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
            err.status = 401;
            throw err;
          },
        },
      },
    },
    async localTranscribe() {
      throw new Error(`401 Incorrect API key provided: ${fakeKeyShape}`);
    },
  });
  assert.equal(result.method, 'placeholder');
  assert.match(result.text, /Transcripci[oó]n no disponible/);
  assert.doesNotMatch(result.text, /sk-proj/);
  assert.doesNotMatch(result.text, /401 Incorrect API key/);
  assert.doesNotMatch(result.text, /OPENAI_API_KEY/);
  assert.doesNotMatch(result.text, /Set OPENAI/);
});

test('aborted OpenAI calls do not fall back to local', async (t) => {
  const filePath = tempAudio(t);
  let localCalls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
      env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_abort' },
      signal: controller.signal,
      openai: {
        audio: {
          transcriptions: {
            async create() {
              const err = new Error('aborted by user');
              err.name = 'AbortError';
              throw err;
            },
          },
        },
      },
      async localTranscribe() {
        localCalls += 1;
        return { text: 'should not run' };
      },
    }),
    /aborted by user/,
  );
  assert.equal(localCalls, 0);
});

// Exercise the shared cloud boundary directly: no ffmpeg or live provider.
// Deferred I/O makes cancellation timing deterministic instead of relying on
// a machine completing disk reads before a short wall-clock timer fires.
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('cloud dispatch does not send an upload cancelled during its file read', async (t) => {
  const filePath = tempAudio(t, 'cancel-during-read.mp3');
  const reading = deferred();
  const resume = deferred();
  const controller = new AbortController();
  let calls = 0;
  const readFile = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', async (target, ...args) => {
    if (target === filePath) {
      reading.resolve();
      await resume.promise;
    }
    return readFile(target, ...args);
  });
  const provider = {
    name: 'openai', model: 'whisper-1', verbose: true,
    client: () => ({ audio: { transcriptions: { create: async () => {
      calls++;
      return { text: 'must not be requested', segments: [] };
    } } } }),
  };
  const pending = audioTranscriber.transcribeCloud(provider, filePath, 'audio/mpeg', 'note.mp3', 1, 100, {
    signal: controller.signal,
    createFile: (bytes) => ({ bytes }),
  });
  try {
    await reading.promise;
    controller.abort();
  } finally {
    resume.resolve();
  }
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0, 'Stop prevents provider dispatch after asynchronous file preparation');
});

test('cloud dispatch does not send after upload construction cancels the request', async (t) => {
  const filePath = tempAudio(t, 'cancel-at-construction.mp3');
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    name: 'openai', model: 'whisper-1', verbose: true,
    client: () => ({ audio: { transcriptions: { create: async () => {
      calls++;
      return { text: 'must not be requested' };
    } } } }),
  };
  await assert.rejects(audioTranscriber.transcribeCloud(provider, filePath, 'audio/mpeg', 'note.mp3', 1, 100, {
    signal: controller.signal,
    createFile: (bytes) => { controller.abort(); return { bytes }; },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cloud dispatch sends an uncancelled upload exactly once', async (t) => {
  const filePath = tempAudio(t, 'uncancelled.mp3');
  const controller = new AbortController();
  const calls = [];
  const provider = {
    name: 'openai', model: 'whisper-1', verbose: true,
    client: () => ({ audio: { transcriptions: { create: async (request, options) => {
      calls.push({ request, options });
      return { text: 'recognized speech', segments: [] };
    } } } }),
  };
  const result = await audioTranscriber.transcribeCloud(provider, filePath, 'audio/mpeg', 'note.mp3', 1, 100, {
    signal: controller.signal,
    createFile: (bytes) => ({ bytes }),
  });
  assert.equal(result.text, 'recognized speech');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(calls[0].request.file.bytes, fs.readFileSync(filePath));
});

test('cloud dispatch rejects a pre-cancelled custom provider without calling it', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = {
    name: 'custom', model: 'test',
    transcribeFile: async () => { calls++; return { text: 'must not be requested' }; },
  };
  await assert.rejects(audioTranscriber.transcribeCloud(provider, '/unused.mp3', 'audio/mpeg', 'note.mp3', 1, 100, {
    signal: controller.signal,
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cloud dispatch rechecks cancellation when a queued custom request gets its turn', async () => {
  const controller = new AbortController();
  const waiting = deferred();
  const resume = deferred();
  let calls = 0;
  const provider = {
    name: 'custom', model: 'test', kind: 'cloud', method: 'whisper',
    transcribeFile: async () => { calls++; return { text: 'must not be requested' }; },
  };
  const context = audioTranscriber.createJobContext({
    options: { env: {} }, signal: controller.signal, rungs: [provider], segmentSeconds: 30,
  });
  context.dispatch = async (start) => {
    waiting.resolve();
    await resume.promise;
    return start();
  };
  const pending = audioTranscriber.transcribeSegmentWithLadder({
    path: '/unused.mp3', mime: 'audio/mpeg', name: 'note.mp3', index: 0, durationSeconds: 1,
  }, context, 'es');
  try {
    await waiting.promise;
    controller.abort();
  } finally {
    resume.resolve();
  }
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 0, 'waiting for dispatch does not authorize a cancelled provider call');
});

test('sanitizeProviderError redacts key-shaped provider text', () => {
  const err = new Error('401 Incorrect API key provided: sk-proj-TESTKEY_z1');
  err.status = 401;
  const sanitized = audioTranscriber.sanitizeProviderError(err);
  assert.doesNotMatch(sanitized, /sk-proj/);
  assert.doesNotMatch(sanitized, /TESTKEY/);
});

function fakeSegments(t, count) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siragpt-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const segments = [];
    for (let i = 0; i < count; i += 1) {
      const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.mp3`);
      fs.writeFileSync(p, Buffer.from(`segment-${i}`));
      segments.push({ path: p, index: i, offsetSeconds: i * 600 });
    }
    return { dir: null, segments };
  };
}

test('a recording above the cloud cap is segmented, transcribed on Meta and stitched with offsets', async (t) => {
  const filePath = tempAudio(t, 'clase.mp4');
  const requests = [];
  const result = await audioTranscriber.transcribe(filePath, 'video/mp4', 'clase.mp4', {
    env: { MODEL_API_KEY: 'meta-test-key', SIRAGPT_META_TRANSCRIPTION: '1', WHISPER_LANGUAGE: 'es' },
    maxFileBytes: 4,
    segmentAudio: fakeSegments(t, 3),
    createFile: (buffer, name, mime) => ({ name, mime, bytes: buffer.length }),
    metaClient: {
      audio: {
        transcriptions: {
          async create(request) {
            requests.push(request);
            const n = requests.length;
            return { text: `parte ${n}`, segments: [{ start: 0, end: 5, text: `parte ${n}` }] };
          },
        },
      },
    },
    async localTranscribe() { throw new Error('local must not run when the cloud ladder succeeds'); },
  });
  assert.equal(result.method, 'whisper');
  assert.equal(result.model, audioTranscriber.DEFAULT_META_TRANSCRIBE_MODEL);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].file.name, 'segment-1.mp3');
  assert.equal(requests[0].file.mime, 'audio/mpeg');
  assert.equal(requests[0].response_format, 'json', 'Meta gets the plain json shape');
  assert.equal(requests[0].language, undefined, 'an unknown length is auto-detected, not forced to the hint');
  assert.match(result.text, /parte 1[\s\S]*parte 2[\s\S]*parte 3/);
  assert.deepEqual(result.segments.map((s) => s.start), [0, 600, 1200]);
});

test('when every cloud provider fails, a big file still reaches local whisper (no size cap there)', async (t) => {
  const filePath = tempAudio(t, 'clase.mp4');
  let localCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'video/mp4', 'clase.mp4', {
    env: { MODEL_API_KEY: 'meta-test-key', SIRAGPT_META_TRANSCRIPTION: '1', OPENAI_API_KEY: 'sk-proj-TESTKEY_m1' },
    maxFileBytes: 4,
    segmentAudio: fakeSegments(t, 1),
    createFile: (buffer, name, mime) => ({ name, mime }),
    openai: { audio: { transcriptions: { async create() { const e = new Error('401 invalid api key'); e.status = 401; throw e; } } } },
    metaClient: { audio: { transcriptions: { async create() { const e = new Error('404 not found'); e.status = 404; throw e; } } } },
    async localTranscribe() { localCalls += 1; return { text: 'transcripción local completa de la clase', model: 'base' }; },
  });
  assert.equal(localCalls, 1);
  assert.equal(result.method, 'local-whisper');
  assert.match(result.text, /transcripción local completa/);
});

test('TRANSCRIBE_PROVIDERS orders the ladder and can skip the cloud entirely', async (t) => {
  assert.deepEqual(audioTranscriber.providerOrder({ env: {} }), ['openai', 'groq', 'xai', 'meta', 'local']);
  assert.deepEqual(audioTranscriber.providerOrder({ env: { TRANSCRIBE_PROVIDERS: 'meta, local' } }), ['meta', 'local']);
  const providers = audioTranscriber.cloudProviders({ env: { MODEL_API_KEY: 'k', OPENAI_API_KEY: 'sk-proj-TESTKEY_m2', TRANSCRIBE_PROVIDERS: 'meta,openai,local' } });
  assert.deepEqual(providers.map((p) => p.name), ['meta', 'openai']);
  assert.deepEqual(audioTranscriber.cloudProviders({ env: { MODEL_API_KEY: 'k', TRANSCRIBE_META_DISABLED: '1' } }).map((p) => p.name), []);

  const filePath = tempAudio(t);
  let cloudCalls = 0;
  const result = await audioTranscriber.transcribe(filePath, 'audio/ogg', 'nota.ogg', {
    env: { MODEL_API_KEY: 'k', TRANSCRIBE_PROVIDERS: 'local' },
    metaClient: { audio: { transcriptions: { async create() { cloudCalls += 1; return { text: 'no' }; } } } },
    async localTranscribe() { return { text: 'solo local, como pide el operador', model: 'base' }; },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(result.method, 'local-whisper');
});

test('subtitle builders emit valid SRT/VTT with renumbering and cleanup', () => {
  assert.equal(audioTranscriber.formatTimestamp(0, ','), '00:00:00,000');
  assert.equal(audioTranscriber.formatTimestamp(3723.5, ','), '01:02:03,500');
  assert.equal(audioTranscriber.formatTimestamp(3723.5, '.'), '01:02:03.500');
  assert.equal(audioTranscriber.formatTimestamp(-4, ','), '00:00:00,000');
  const srt = audioTranscriber.buildSrt([
    { start: 0, end: 2.5, text: 'Hola' },
    { start: 3, end: 3, text: 'Mundo' },
    { start: 5, end: 4, text: 'invertido' },
    { start: 7, end: 8, text: '   ' },
  ]);
  assert.equal(srt, [
    '1', '00:00:00,000 --> 00:00:02,500', 'Hola', '',
    '2', '00:00:03,000 --> 00:00:03,500', 'Mundo', '',
    '3', '00:00:05,000 --> 00:00:05,500', 'invertido',
  ].join('\n'));
  const vtt = audioTranscriber.buildVtt([{ start: 61.25, end: 63, text: 'Minuto uno' }]);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:01:01.250 --> 00:01:03.000'));
  assert.equal(audioTranscriber.buildSrt([]), '');
  assert.equal(audioTranscriber.buildSrt(null), '');
  assert.equal(audioTranscriber.buildVtt([]), '');
});

test('segmented cloud transcription reports progress per segment', async (t) => {
  const filePath = tempAudio(t, 'clase-larga.mp4');
  const events = [];
  const result = await audioTranscriber.transcribe(filePath, 'video/mp4', 'clase-larga.mp4', {
    env: { MODEL_API_KEY: 'meta-test-key', SIRAGPT_META_TRANSCRIPTION: '1' },
    maxFileBytes: 4,
    segmentAudio: fakeSegments(t, 4),
    createFile: (buffer, name, mime) => ({ name, mime }),
    onProgress: (event) => events.push(event),
    metaClient: {
      audio: { transcriptions: { async create() { return { text: 'parte larga con suficientes caracteres', segments: [] }; } } },
    },
    async localTranscribe() { throw new Error('local must not run when the cloud ladder succeeds'); },
  });
  assert.equal(result.method, 'whisper');
  assert.deepEqual(events.map((e) => e.stage), ['preparing', 'segments', 'transcribe', 'transcribe', 'transcribe', 'transcribe', 'done']);
  assert.deepEqual(events.slice(1).map((e) => e.completed), [0, 1, 2, 3, 4, 4]);
  assert.ok(events.slice(1).every((e) => e.total === 4 && e.gaps === 0));
});

test('long local transcription resumes from per-segment checkpoints after a restart', async (t) => {
  const filePath = tempAudio(t, 'clase-10h.mkv');
  const store = new Map();
  const checkpoint = {
    async load(index, meta) {
      const saved = store.get(index);
      return saved && saved.meta.total === meta.total && saved.meta.segmentSeconds === meta.segmentSeconds ? saved.part : null;
    },
    async save(index, meta, part) { store.set(index, { meta, part }); },
  };
  const calls = [];
  const base = {
    env: { TRANSCRIBE_PROVIDERS: 'local' },
    durationSeconds: 10 * 3600,
    segmentAudio: fakeSegments(t, 60),
    checkpoint,
  };
  // First run dies on segment 24 (deploy / container recreated: the job is
  // cancelled mid-file, it does not fail).
  const controller = new AbortController();
  await assert.rejects(audioTranscriber.transcribe(filePath, 'video/x-matroska', 'clase-10h.mkv', {
    ...base,
    signal: controller.signal,
    async localTranscribe(segPath) {
      calls.push(segPath);
      if (calls.length === 24) {
        controller.abort();
        throw Object.assign(new Error('local whisper cancelled'), { code: 'LOCAL_WHISPER_ABORTED' });
      }
      return { text: `bloque ${calls.length} con suficientes palabras`, segments: [{ start: 0, end: 5, text: 'x' }], model: 'base' };
    },
  }), { name: 'AbortError' });
  assert.equal(store.size, 23, 'every finished segment is persisted before the crash');
  const resumed = [];
  const events = [];
  const result = await audioTranscriber.transcribe(filePath, 'video/x-matroska', 'clase-10h.mkv', {
    ...base,
    onProgress: (event) => events.push(event),
    async localTranscribe(segPath) {
      resumed.push(segPath);
      return { text: `bloque reanudado con suficientes palabras`, segments: [{ start: 0, end: 5, text: 'y' }], model: 'base' };
    },
  });
  assert.equal(result.method, 'local-whisper');
  assert.equal(resumed.length, 37, 'only the 37 unfinished segments are transcribed again');
  assert.equal(store.size, 60);
  assert.deepEqual(events.find((e) => e.stage === 'resuming'), { stage: 'resuming', durationSeconds: 36000, completed: 23, total: 60, gaps: 0 });
  assert.equal(events.at(-1).stage, 'done');
  assert.equal(events.at(-1).completed, 60);
  assert.equal(events.at(-1).durationSeconds, 36000);
  assert.ok(result.transcript.startsWith('bloque 1 con suficientes palabras'));
  assert.equal(result.segments.at(-1).start, 59 * 600, 'timestamps keep their offset into the 10-hour file');
});

test('segmentation budget scales with duration: a 10-hour file gets an hour, short clips keep 10 minutes', () => {
  assert.equal(audioTranscriber.segmentationTimeoutMs({ durationSeconds: 120, env: {} }), 10 * 60 * 1000);
  assert.equal(audioTranscriber.segmentationTimeoutMs({ durationSeconds: 36000, env: {} }), 60 * 60 * 1000);
  assert.equal(audioTranscriber.segmentationTimeoutMs({ durationSeconds: 36000, env: { TRANSCRIBE_SEGMENT_TIMEOUT_MS: '5000' } }), 5000);
});
