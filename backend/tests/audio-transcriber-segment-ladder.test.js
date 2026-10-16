'use strict';

/**
 * Long-media robustness: the SEGMENT (not the file) is the unit of fallback.
 * The cut happens once per job, each segment climbs the ladder on its own,
 * a segment no rung can read becomes a gap (partial result) instead of
 * discarding hours of finished work, cloud segments run in a bounded pool,
 * and every chunk reports the engine that produced it.
 */

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audio = require('../src/services/audio-transcriber');

function tempFile(t, name = 'clase.mp4') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-ladder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'fake-video');
  return file;
}

function segmenter(t, count, seconds = 600) {
  const calls = { n: 0 };
  const fn = async () => {
    calls.n++;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-ladder-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
      dir,
      segments: Array.from({ length: count }, (_, i) => {
        const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
        fs.writeFileSync(p, `segment-${i}`);
        return { path: p, index: i, offsetSeconds: i * seconds };
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

const indexOf = (name) => Number(/segment-(\d+)/.exec(String(name))[1]) - 1;
const createFile = (_buffer, name, mime) => ({ name, mime });
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

function sdk(handler) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request, requestOptions) {
      const index = indexOf(request.file.name);
      requests.push({ index, language: request.language, requestOptions });
      return handler(index, request);
    } } },
  };
}

const noSleep = { sleeps: [], sleep: async function sleep(ms) { noSleep.sleeps.push(ms); } };

test.beforeEach(() => {
  audio.clearTranscriptionCooldowns();
  noSleep.sleeps = [];
});

test('the file is cut ONCE even when the first two rungs fail on segment 0; each segment keeps its own ladder', async (t) => {
  const segmentAudio = segmenter(t, 3);
  const openai = sdk((i) => { if (i === 0) throw httpError(400, 'Audio file might be corrupted'); return { text: `openai ${i}`, segments: [{ start: 0, end: 1, text: `openai ${i}` }] }; });
  const groq = sdk((i) => { if (i === 0) throw httpError(400, 'could not process file'); return { text: `groq ${i}`, segments: [] }; });
  const local = [];
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { OPENAI_API_KEY: 'sk-proj-TESTKEY_once', GROQ_API_KEY: 'gsk_once' }, language: 'es', durationSeconds: 1800,
    openai, groqClient: groq, createFile, segmentAudio, ...noSleep,
    async localTranscribe(p) { local.push(path.basename(p)); return { text: 'local 0', segments: [{ start: 2, end: 3, text: 'local 0' }], model: 'ggml-base.bin' }; },
  });
  assert.equal(segmentAudio.calls.n, 1, 'one cut for the whole job, whatever the number of rungs tried');
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(local, ['seg-0000.flac'], 'only segment 0 fell to local');
  assert.deepEqual(groq.requests.map((r) => r.index), [0], 'groq is only asked for the segment openai could not read');
  assert.equal(result.transcript, 'local 0\n\nopenai 1\n\nopenai 2');
  assert.deepEqual(result.providers, { local: 1, openai: 2 });
  assert.equal(result.engine, 'mixed');
  assert.equal(result.method, 'whisper');
  assert.equal(result.model, 'whisper-1', 'the model that produced most of the text');
  assert.deepEqual(result.segments.map((s) => s.start), [2, 600, 1200]);
});

test('a deterministic bad segment 7 of 30 becomes a gap: ok, partial, exact times, 29/30 coverage', async (t) => {
  const events = [];
  const groq = sdk((i) => { if (i === 7) throw httpError(400, 'invalid audio'); return { text: `parte ${i + 1}`, segments: [{ start: 0, end: 4, text: `parte ${i + 1}` }] }; });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase-5h.mp4', {
    env: { GROQ_API_KEY: 'gsk_gap' }, language: 'es', durationSeconds: 18000,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 30), onProgress: (e) => events.push(e), ...noSleep,
    async localTranscribe() { throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED' }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.partial, true);
  assert.deepEqual(result.gaps, [{ start: 4200, end: 4800, reason: 'audio_decode_failed' }]);
  assert.equal(result.coverage, Math.round((29 / 30) * 10000) / 10000);
  assert.equal(result.segmentCount, 30);
  assert.equal(result.durationSec, 18000);
  assert.deepEqual(result.providers, { groq: 29 });
  assert.equal(result.engine, 'cloud');
  assert.match(result.transcript, /parte 7\n\n\[01:10:00–01:20:00: no se pudo transcribir este tramo\]\n\nparte 9/);
  assert.match(result.text, /^Transcripción parcial — .*tramos sin transcribir: 1 de 30/);
  assert.equal(result.segments.length, 29);
  assert.equal(result.segments.at(-1).start, 29 * 600);
  const done = events.at(-1);
  assert.deepEqual({ stage: done.stage, completed: done.completed, total: done.total, gaps: done.gaps }, { stage: 'done', completed: 30, total: 30, gaps: 1 });
  assert.ok(events.filter((e) => e.stage === 'transcribe').every((e, i, list) => i === 0 || e.completed > list[i - 1].completed));
});

test('coverage under TRANSCRIBE_MIN_COVERAGE is a failure with a specific reason; the threshold is tunable', async (t) => {
  const run = (env) => audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local', ...env }, language: 'es', durationSeconds: 6000,
    segmentAudio: segmenter(t, 10), ...noSleep,
    async localTranscribe(p) {
      const i = Number(/seg-(\d+)\.flac$/.exec(p)[1]); // the temp dir name also contains «seg-»
      if ([2, 5, 8].includes(i)) throw Object.assign(new Error('whisper exited 139'), { code: 'LOCAL_WHISPER_FAILED' });
      return { text: `bloque ${i}` };
    },
  });
  const low = await run({});
  assert.equal(low.ok, false);
  assert.equal(low.reasonCode, 'low_coverage');
  assert.equal(low.method, 'placeholder');
  assert.equal(low.coverage, 0.7);
  assert.equal(low.gaps.length, 3);
  assert.equal(low.partial, true);
  assert.match(low.text, /Transcripción no disponible/);
  const tolerated = await run({ TRANSCRIBE_MIN_COVERAGE: '0.6' });
  assert.equal(tolerated.ok, true);
  assert.equal(tolerated.partial, true);
});

test('nothing transcribed: the queue-retryable reason, and decode failures are named as such', async (t) => {
  const unavailable = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, language: 'es', durationSeconds: 1800, segmentAudio: segmenter(t, 3), ...noSleep,
    async localTranscribe() { throw Object.assign(new Error('local whisper unavailable: model missing'), { code: 'LOCAL_WHISPER_UNAVAILABLE', reason: 'model missing' }); },
  });
  assert.equal(unavailable.reasonCode, 'local_unavailable');
  assert.equal(unavailable.coverage, 0);
  const broken = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, language: 'es', durationSeconds: 1800, segmentAudio: segmenter(t, 3), ...noSleep,
    async localTranscribe() { throw Object.assign(new Error('Audio could not be decoded'), { code: 'AUDIO_DECODE_FAILED' }); },
  });
  assert.equal(broken.reasonCode, 'audio_decode_failed');
});

test('cloud segments run 3 at a time, start in segment order and are stitched by index', async (t) => {
  let active = 0;
  let peak = 0;
  const groq = sdk(async (i) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, (9 - i) * 3)); // later segments finish first
    active--;
    return { text: `parte ${i}`, segments: [{ start: 1, end: 2, text: `parte ${i}` }] };
  });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_pool' }, language: 'es', durationSeconds: 5400,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 9), ...noSleep,
  });
  assert.equal(peak, 3);
  assert.deepEqual(groq.requests.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'request starts follow segment order');
  assert.equal(result.transcript, Array.from({ length: 9 }, (_, i) => `parte ${i}`).join('\n\n'));
  assert.deepEqual(result.segments.map((s) => s.start), Array.from({ length: 9 }, (_, i) => i * 600 + 1));
  assert.equal(groq.requests[0].requestOptions.maxRetries, 0, 'the ladder retries, not the SDK');
  assert.equal(groq.requests[0].requestOptions.timeout, 240000, 'a 10-min segment gets a 4-min request budget');

  active = 0; peak = 0;
  await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_pool', TRANSCRIBE_CLOUD_PARALLEL: '1' }, language: 'es', durationSeconds: 1800,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 3), ...noSleep,
  });
  assert.equal(peak, 1);
});

test('local whisper stays one process per job (TRANSCRIBE_LOCAL_PARALLEL raises it)', async (t) => {
  const run = async (env) => {
    let active = 0;
    let peak = 0;
    await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
      env: { TRANSCRIBE_PROVIDERS: 'local', ...env }, language: 'es', durationSeconds: 2400, segmentAudio: segmenter(t, 4), ...noSleep,
      async localTranscribe() { peak = Math.max(peak, ++active); await new Promise((r) => setTimeout(r, 5)); active--; return { text: 'bloque' }; },
    });
    return peak;
  };
  assert.equal(await run({}), 1);
  assert.equal(await run({ TRANSCRIBE_LOCAL_PARALLEL: '2' }), 2);
});

test('a parallel job aborted mid-file resumes with exactly the missing segments', async (t) => {
  const store = new Map();
  const checkpoint = { async load(i) { return store.get(i) || null; }, async save(i, _meta, part) { store.set(i, part); } };
  const segmentAudio = segmenter(t, 12);
  const controller = new AbortController();
  let finished = 0;
  const first = sdk(async (i) => {
    await new Promise((r) => setTimeout(r, 2));
    if (++finished === 6) controller.abort();
    return { text: `parte ${i}` };
  });
  await assert.rejects(audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_resume' }, language: 'es', durationSeconds: 7200, signal: controller.signal,
    groqClient: first, createFile, segmentAudio, checkpoint, ...noSleep,
  }), { name: 'AbortError' });
  const saved = store.size;
  const savedIndices = new Set(store.keys());
  assert.ok(saved >= 5 && saved < 12, `finished parts are durable (${saved})`);
  const second = sdk(async (i) => ({ text: `parte ${i}` }));
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_resume' }, language: 'es', durationSeconds: 7200, signal: new AbortController().signal,
    groqClient: second, createFile, segmentAudio, checkpoint, ...noSleep,
  });
  assert.equal(second.requests.length, 12 - saved);
  assert.equal(new Set(second.requests.map((r) => r.index)).size, 12 - saved);
  assert.ok(second.requests.every((r) => !savedIndices.has(r.index)), 'no finished segment is paid for twice');
  assert.equal(result.transcript, Array.from({ length: 12 }, (_, i) => `parte ${i}`).join('\n\n'));
  assert.ok([...store.values()].every((part) => part.provider === 'groq' && part.model === 'whisper-large-v3-turbo' && part.language === 'es' && part.cutPlan));
});

test('a dead key drops the rung for the job (and 30 min process-wide); later segments go straight to the next rung', async (t) => {
  const groq = sdk(() => { throw httpError(401, 'Invalid API Key'); });
  const local = [];
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_dead_job' }, language: 'es', durationSeconds: 2400, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 4), ...noSleep,
    async localTranscribe(p) { local.push(path.basename(p)); return { text: 'local' }; },
  });
  assert.equal(groq.requests.length, 1);
  assert.equal(local.length, 4);
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_dead_job' }), true);
  assert.deepEqual(result.providers, { local: 4 });
  assert.equal(result.engine, 'local');
  assert.equal(result.method, 'local-whisper');
});

test('a transient 503 is retried twice on the same provider with backoff, then the segment is demoted', async (t) => {
  let calls = 0;
  const groq = sdk((i) => {
    calls++;
    if (i === 0 && calls <= 2) throw httpError(503, 'Service Unavailable');
    if (i === 1) throw httpError(502, 'Bad Gateway');
    return { text: `groq ${i}` };
  });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_flaky' }, language: 'es', durationSeconds: 1200, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 2), ...noSleep,
    async localTranscribe() { return { text: 'local 1' }; },
  });
  assert.deepEqual(groq.requests.map((r) => r.index), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(noSleep.sleeps, [2000, 6000, 2000, 6000]);
  assert.equal(result.transcript, 'groq 0\n\nlocal 1');
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_flaky' }), false, 'a 5xx is never a cooldown');
});

test('three segments failing in a row on a rung stop it for the rest of the job', async (t) => {
  const groq = sdk(() => { throw httpError(400, 'bad request'); });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_streak' }, language: 'es', durationSeconds: 3600, parallel: 1,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 6), ...noSleep,
    async localTranscribe() { return { text: 'local' }; },
  });
  assert.equal(groq.requests.length, 3);
  assert.deepEqual(result.providers, { local: 6 });
  assert.equal(audio.providerInCooldown({ name: 'groq', key: 'gsk_streak' }), false);
});

test('a dropped socket («Error: aborted», ECONNRESET) is a transient failure, not a cancelled job', async (t) => {
  let calls = 0;
  const groq = sdk((i) => {
    calls++;
    if (i === 0 && calls === 1) throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    return { text: `groq ${i}` };
  });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { GROQ_API_KEY: 'gsk_socket' }, language: 'es', durationSeconds: 1200, parallel: 1,
    signal: new AbortController().signal,
    groqClient: groq, createFile, segmentAudio: segmenter(t, 2), ...noSleep,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(groq.requests.map((r) => r.index), [0, 0, 1]);
  assert.equal(result.transcript, 'groq 0\n\ngroq 1');
});

function fakeProcess(exitCode, write) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    try { write?.(); } catch (error) { child.emit('error', error); return; }
    child.emit('close', exitCode);
  });
  return child;
}

test('one failed whisper.cpp run (python fallback without faster-whisper) demotes only that segment; local keeps the rest of the job', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-ladder-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model');
  const calls = { whisper: 0, python: 0 };
  // The real engine (transcribeLocal) with fake processes: ffmpeg copies the
  // segment into the WAV, whisper-cli exits 1 on segment 2 only, python3 exits
  // 2 like production (no faster-whisper installed).
  const spawnImpl = (command, args) => {
    if (command === 'ffmpeg') return fakeProcess(0, () => fs.writeFileSync(args.at(-1), fs.readFileSync(args[args.indexOf('-i') + 1])));
    if (command === bin) {
      calls.whisper++;
      const audioText = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
      if (audioText === 'segment-2') return fakeProcess(1);
      return fakeProcess(0, () => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({
        transcription: [{ offsets: { from: 0, to: 1000 }, text: `bloque ${audioText}` }],
      })));
    }
    calls.python++;
    return fakeProcess(2);
  };
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, language: 'es', durationSeconds: 6000,
    segmentAudio: segmenter(t, 10), whisperBin: bin, modelPath: model, spawnImpl, logImpl() {}, ...noSleep,
  });
  // Local is the last engine: the failing piece is backed off and retried
  // (30 s, 2 min, 10 min) instead of becoming a gap at once; python is
  // remembered as missing after its first import failure.
  assert.equal(calls.whisper, 13, 'every later segment still reaches whisper.cpp; segment 3 gets 3 backoff retries');
  assert.deepEqual(noSleep.sleeps, [30_000, 120_000, 600_000]);
  assert.equal(calls.python, 1);
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.deepEqual(result.gaps, [{ start: 1200, end: 1800, reason: 'provider_error' }]);
  assert.equal(result.coverage, 0.9);
  assert.deepEqual(result.providers, { local: 9 });
});

test('a transient spawn failure (EAGAIN) on a late segment fails only that segment; EACCES still drops the rung', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-ladder-spawn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'whisper-cli');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const model = path.join(dir, 'ggml-base.bin');
  fs.writeFileSync(model, 'model');
  const spawnError = (code) => Object.assign(new Error(`spawn ${code}`), { code });
  // The real engine with fake processes: whisper-cli fails to fork with
  // `failCode` on the segments `failOn` picks; python3 exits 2 like production.
  const engine = (failCode, failOn) => {
    const calls = { whisper: 0, python: 0 };
    const spawnImpl = (command, args) => {
      if (command === 'ffmpeg') return fakeProcess(0, () => fs.writeFileSync(args.at(-1), fs.readFileSync(args[args.indexOf('-i') + 1])));
      if (command === bin) {
        calls.whisper++;
        const audioText = fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8');
        if (failOn(audioText, calls.whisper)) return fakeProcess(0, () => { throw spawnError(failCode); });
        return fakeProcess(0, () => fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify({
          transcription: [{ offsets: { from: 0, to: 1000 }, text: `bloque ${audioText}` }],
        })));
      }
      calls.python++;
      return fakeProcess(2);
    };
    return { calls, spawnImpl };
  };
  const run = (spawnImpl) => audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local' }, language: 'es', durationSeconds: 6000,
    segmentAudio: segmenter(t, 10), whisperBin: bin, modelPath: model, spawnImpl, logImpl() {}, ...noSleep,
  });

  const busy = engine('EAGAIN', (audioText) => audioText === 'segment-8');
  const result = await run(busy.spawnImpl);
  assert.equal(busy.calls.whisper, 13, 'segment 10 still reaches whisper.cpp after an EAGAIN on segment 9 (retried 3 times)');
  assert.equal(result.ok, true);
  assert.deepEqual(result.gaps, [{ start: 4800, end: 5400, reason: 'provider_error' }]);
  assert.equal(result.coverage, 0.9);
  assert.deepEqual(result.providers, { local: 9 });

  const denied = engine('EACCES', () => true);
  const dead = await run(denied.spawnImpl);
  assert.equal(denied.calls.whisper, 1, 'a binary the OS refuses to run is unavailable for the whole job');
  assert.equal(dead.ok, false);
});

test('a whisper.cpp timeout is retried with TRANSCRIBE_LOCAL_RETRIES, else a timeout gap; only a missing engine drops the rung', async (t) => {
  const timeoutOnce = () => {
    const seen = new Map();
    const fn = async (p) => {
      const i = Number(/seg-(\d+)\.flac$/.exec(p)[1]);
      seen.set(i, (seen.get(i) || 0) + 1);
      fn.calls++;
      if (i === 1 && seen.get(i) === 1) {
        throw Object.assign(new Error('local whisper unavailable: whisper.cpp LOCAL_WHISPER_TIMEOUT; python fallback LOCAL_WHISPER_FAILED'), {
          code: 'LOCAL_WHISPER_UNAVAILABLE', cppError: { code: 'LOCAL_WHISPER_TIMEOUT' },
        });
      }
      return { text: `bloque ${i}` };
    };
    fn.calls = 0;
    return fn;
  };
  const run = (env, localTranscribe) => audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_MIN_COVERAGE: '0.5', ...env }, language: 'es', durationSeconds: 2400,
    segmentAudio: segmenter(t, 4), localTranscribe, ...noSleep,
  });
  // Local is the last engine left: a timeout backs off 30 s and retries.
  const backedOff = timeoutOnce();
  const recovered = await run({}, backedOff);
  assert.equal(backedOff.calls, 5);
  assert.deepEqual(noSleep.sleeps, [30_000]);
  assert.equal(recovered.partial, false);
  // Without a wait budget, a timeout is a timeout gap (the old behaviour).
  const once = timeoutOnce();
  const gap = await run({ TRANSCRIBE_LAST_RUNG_WAIT_BUDGET_MS: '0' }, once);
  assert.equal(once.calls, 4, 'segments 2-4 still run locally');
  assert.deepEqual(gap.gaps, [{ start: 600, end: 1200, reason: 'timeout' }]);
  const retried = timeoutOnce();
  const healed = await run({ TRANSCRIBE_LOCAL_RETRIES: '1' }, retried);
  assert.equal(retried.calls, 5);
  assert.equal(healed.partial, false);
  assert.equal(healed.transcript, 'bloque 0\n\nbloque 1\n\nbloque 2\n\nbloque 3');

  let missingCalls = 0;
  const missing = await run({}, async () => {
    missingCalls++;
    throw Object.assign(new Error('local whisper unavailable: model missing'), {
      code: 'LOCAL_WHISPER_UNAVAILABLE', reason: 'model missing', cppError: { code: 'LOCAL_WHISPER_UNAVAILABLE', reason: 'model missing' },
    });
  });
  assert.equal(missingCalls, 1, 'a missing model is unavailable for the whole job');
  assert.equal(missing.reasonCode, 'local_unavailable');
});

test('a silent piece on xAI (200 with no text) is no speech, not a failure: xAI keeps the rest of the job and no gap opens', async (t) => {
  const calls = [];
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { XAI_API_KEY: 'xai-silent-waiting-room', TRANSCRIBE_PROVIDERS: 'xai' }, language: 'es', durationSeconds: 3600, parallel: 1,
    segmentAudio: segmenter(t, 6), ...noSleep,
    async xaiTranscribe(_file, _mime, name) {
      const i = indexOf(name);
      calls.push(i);
      if (i < 3) throw Object.assign(new Error('xAI STT response did not include transcript text.'), { code: 'xai_stt_empty_transcript' });
      return { text: `parte ${i}`, model: 'grok-stt', segments: [] };
    },
  });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5], 'three silent pieces in a row do not drop xAI');
  assert.equal(result.ok, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.gaps || [], []);
  assert.equal(result.coverage, 1);
  assert.deepEqual(result.providers, { xai: 6 });
  assert.equal(result.transcript, 'parte 3\n\nparte 4\n\nparte 5');
});
