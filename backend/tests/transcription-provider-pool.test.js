'use strict';

// The provider pool of the transcription engine (100 videos × 10 h): every
// cloud request takes a process-wide per-provider permit (transcription-
// governor); a piece skips a provider with no free slot NOW for the next
// healthy one (spread) unless TRANSCRIBE_SCHEDULING=ladder; a 429 seen by
// one job pauses the provider for every job; jobs with a usable cloud rung
// are admitted through a cloud pool on top of the two shared CPU slots;
// whisper.cpp processes of concurrent long jobs share one cap; and the new
// rungs (ElevenLabs first pass with speakers, AssemblyAI, Deepgram, Mistral
// opt-in) are key-gated. Offline: fake SDKs, fake clocks, no binaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audio = require('../src/services/audio-transcriber');
const keyHealth = require('../src/utils/provider-key-health');

function tempFile(t, name = 'clase.mp4') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'fake-video');
  return file;
}

function segmenter(t, count, seconds = 600) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pool-seg-'));
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
}

const indexOf = (name) => { const m = /segment-(\d+)/.exec(String(name)); return m ? Number(m[1]) - 1 : -1; };
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const createFile = (_buffer, name, mime) => ({ name, mime });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function sdk(handler) {
  const requests = [];
  return {
    requests,
    audio: { transcriptions: { async create(request, requestOptions) {
      const index = indexOf(request.file.name);
      requests.push({ index, request, requestOptions });
      return handler(index, request);
    } } },
  };
}

function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

/** options.transcodeClip fake: a FLAC-looking master in its own dir (short clips). */
function fakeMaster(t, durationSeconds = 20) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-pool-master-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const out = path.join(dir, 'audio.flac');
    fs.writeFileSync(out, 'fLaC-master');
    return { ok: true, path: out, dir, size: 11, durationSeconds, tolerant: false, decodeCause: null, streamDropped: false };
  };
}
const clip = (t, extra = {}) => ({ durationSeconds: 20, transcodeClip: fakeMaster(t), createFile, ffmpegFilters: [], ...extra });
const SENTENCE = 'Hola a todos, empezamos la clase de hoy con el tema pendiente.';

function elevenLabsFake(text) {
  const calls = [];
  const tokens = text.split(' ');
  return {
    calls,
    speechToText: { async convert(request, requestOptions) {
      calls.push({ modelId: request.modelId, diarize: request.diarize, languageCode: request.languageCode, keyterms: request.keyterms, timeout: requestOptions.timeoutInSeconds });
      const words = tokens.map((w, i) => ({ text: w, start: i * 2, end: i * 2 + 1.5, type: 'word', logprob: -0.05, speaker_id: i < tokens.length / 2 ? 'speaker_0' : 'speaker_1' }));
      return { languageCode: 'spa', text, words };
    } },
  };
}

test.beforeEach(() => audio.clearTranscriptionCooldowns());
test.afterEach(() => audio.clearTranscriptionCooldowns());

test('spread: a provider with no free slot NOW is skipped for the next one; ladder waits for the first', async (t) => {
  const run = async (scheduling) => {
    const env = { OPENAI_API_KEY: 'sk-proj-TESTKEY_pool1', GROQ_API_KEY: 'gsk_pool1', TRANSCRIBE_PROVIDERS: 'openai,groq', TRANSCRIBE_OPENAI_IN_FLIGHT: '1', TRANSCRIBE_SCHEDULING: scheduling };
    const openai = sdk(async (i) => { await tick(); await tick(); return { text: `openai ${i}`, segments: [] }; });
    const groq = sdk(async (i) => { await tick(); return { text: `groq ${i}`, segments: [] }; });
    const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
      env, language: 'es', durationSeconds: 3600, parallel: 3, openai, groqClient: groq, createFile, segmentAudio: segmenter(t, 6),
      async localTranscribe() { throw new Error('local must not run'); },
    });
    return { result, openai, groq };
  };
  const spread = await run('spread');
  assert.equal(spread.result.partial, false);
  assert.ok(spread.result.providers.openai >= 1 && spread.result.providers.groq >= 1, JSON.stringify(spread.result.providers));
  assert.equal(spread.result.providers.openai + spread.result.providers.groq, 6);
  assert.equal(spread.result.engine, 'cloud');
  const ladder = await run('ladder');
  assert.deepEqual(ladder.result.providers, { openai: 6 });
  assert.equal(ladder.groq.requests.length, 0, 'ladder: every piece waits for the first provider');
  assert.equal(audio.schedulingMode({ env: {} }), 'spread');
  assert.equal(audio.schedulingMode({ env: { TRANSCRIBE_SCHEDULING: 'LADDER' } }), 'ladder');
});

test('a rate limit recorded by one job pauses the provider for the next job: its pieces wait the Retry-After out instead of hammering', async (t) => {
  const clock = fakeClock();
  const env = { GROQ_API_KEY: 'gsk_pool2', TRANSCRIBE_PROVIDERS: 'groq' };
  const governor = audio.governorFor({ env, now: clock.now, sleep: clock.sleep });
  governor.noteRateLimited('groq', 60_000); // another job's 429 with Retry-After: 60
  const startedAt = [];
  const groq = sdk((i) => { startedAt.push({ i, t: clock.t }); return { text: `parte ${i}`, segments: [] }; });
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env, language: 'es', durationSeconds: 1800, groqClient: groq, createFile, segmentAudio: segmenter(t, 3), sleep: clock.sleep, now: clock.now,
  });
  assert.equal(result.partial, false);
  assert.equal(startedAt.length, 3);
  assert.ok(startedAt.every((r) => r.t >= 60_000), JSON.stringify(startedAt));
  assert.equal(clock.sleeps[0], 60_000);
  assert.equal(governor.snapshot().groq.completed, 3);
  assert.equal(audio.governorFor({ env }), governor, 'jobs that share an env share the ledger');
});

test('admission: jobs with a usable cloud rung use the cloud pool on top of the shared slots; local-only jobs still wait for a shared slot', async () => {
  const enqueue = audio._enqueueTranscription;
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const ctrl = new AbortController();
  const holds = [];
  for (let i = 0; i < audio.TRANSCRIPTION_CONCURRENCY; i++) { const h = deferred(); holds.push(h); enqueue(() => h.promise, ctrl.signal, null); }
  let localStarted = false;
  const localWaiter = enqueue(async () => { localStarted = true; return 'local'; }, ctrl.signal, null);
  const poolSize = audio.cloudPoolConcurrency();
  assert.equal(poolSize, 6);
  let cloudStarted = 0;
  const cloudHolds = [];
  const cloudJobs = [];
  for (let i = 0; i < poolSize; i++) {
    const h = deferred();
    cloudHolds.push(h);
    cloudJobs.push(enqueue(() => { cloudStarted++; return h.promise; }, ctrl.signal, null, { cloud: true }));
  }
  await tick();
  assert.equal(cloudStarted, poolSize, 'every cloud-capable job starts while the shared slots are full');
  assert.equal(localStarted, false);
  let extraStarted = false;
  const extra = enqueue(async () => { extraStarted = true; return 'extra'; }, ctrl.signal, null, { cloud: true });
  await tick();
  assert.equal(extraStarted, false, 'the cloud pool is full');
  cloudHolds[0].resolve('c');
  await cloudJobs[0];
  await tick();
  assert.equal(extraStarted, true, 'a freed cloud slot admits the next cloud job');
  assert.equal(localStarted, false, 'a local-only job never takes a cloud slot');
  for (const h of holds) h.resolve('done');
  assert.equal(await localWaiter, 'local');
  for (const h of cloudHolds) h.resolve('c');
  await Promise.all([...cloudJobs, extra]);

  // TRANSCRIBE_CLOUD_CONCURRENCY=0: a cloud job waits like any other.
  process.env.TRANSCRIBE_CLOUD_CONCURRENCY = '0';
  try {
    const again = [];
    for (let i = 0; i < audio.TRANSCRIPTION_CONCURRENCY; i++) { const h = deferred(); again.push(h); enqueue(() => h.promise, ctrl.signal, null); }
    let started = false;
    const waiting = enqueue(async () => { started = true; return 'c'; }, ctrl.signal, null, { cloud: true });
    await tick();
    assert.equal(started, false);
    for (const h of again) h.resolve('x');
    assert.equal(await waiting, 'c');
  } finally {
    delete process.env.TRANSCRIBE_CLOUD_CONCURRENCY;
  }
  assert.equal(audio.sharedConcurrency(), audio.TRANSCRIPTION_CONCURRENCY);
});

test('cloudCapable: a configured key not in cooldown; cloudCapacityAvailable also needs a free slot', () => {
  assert.equal(audio.cloudCapable({ env: {} }), false);
  const env = { GROQ_API_KEY: 'gsk_cap' };
  assert.equal(audio.cloudCapable({ env }), true);
  assert.equal(audio.cloudCapacityAvailable({ env }), true);
  audio.governorFor({ env }).noteRateLimited('groq', 30_000);
  assert.equal(audio.cloudCapable({ env }), true, 'a paused provider is still configured');
  assert.equal(audio.cloudCapacityAvailable({ env }), false, 'but it cannot take a piece now');
  assert.equal(audio.governorSnapshot({ env }).groq.rateLimits, 1);
  keyHealth.markRejected('transcribe:groq', 'gsk_cap', Object.assign(new Error('bad key'), { status: 401 }), env);
  assert.equal(audio.cloudCapable({ env }), false, 'a key in cooldown is not usable');
});

test('whisper.cpp processes of concurrent long jobs share one cap (TRANSCRIBE_LOCAL_PARALLEL_TOTAL, never below the per-job value)', async (t) => {
  // Each piece waits until all four could be running: the peak then shows
  // the cap, never how the two jobs happened to interleave on a busy machine.
  // Under a cap of two the wait is short (two is the right answer anyway);
  // under a cap of four it lasts until the other job's pieces arrive.
  const run = async (env, waitMs) => {
    let active = 0;
    let peak = 0;
    const opts = () => ({
      env, language: 'es', durationSeconds: 1200, segmentAudio: segmenter(t, 2),
      async localTranscribe() {
        peak = Math.max(peak, ++active);
        const until = Date.now() + waitMs;
        while (active < 4 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { text: 'Hola a todos, empezamos la clase de hoy con el tema pendiente.' };
      },
    });
    await Promise.all([
      audio.transcribe(tempFile(t, 'a.mp4'), 'video/mp4', 'a.mp4', opts()),
      audio.transcribe(tempFile(t, 'b.mp4'), 'video/mp4', 'b.mp4', opts()),
    ]);
    return peak;
  };
  assert.equal(await run({ TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_LOCAL_PARALLEL: '2' }, 300), 2, 'two jobs × two per job would be four; the shared cap keeps two');
  assert.equal(await run({ TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_LOCAL_PARALLEL: '2', TRANSCRIBE_LOCAL_PARALLEL_TOTAL: '4' }, 10_000), 4);
});

test('the pool rungs: ElevenLabs first pass, AssemblyAI, Deepgram in the default order, Mistral opt-in; every one key-gated and switchable', () => {
  const env = { ELEVENLABS_API_KEY: 'el', ASSEMBLYAI_API_KEY: 'aai', DEEPGRAM_API_KEY: 'dg', MISTRAL_API_KEY: 'mi', OPENAI_API_KEY: 'sk-proj-TESTKEY_pool6' };
  const names = (e) => audio.cloudProviders({ env: e }).map((r) => r.name);
  assert.deepEqual(audio.DEFAULT_PROVIDER_ORDER, ['elevenlabs', 'assemblyai', 'openai', 'groq', 'deepgram', 'xai', 'meta', 'local']);
  assert.deepEqual(names(env), ['elevenlabs', 'assemblyai', 'openai', 'deepgram'], 'the default order; Mistral only when listed');
  assert.deepEqual(names({ ...env, TRANSCRIBE_PROVIDERS: 'mistral,deepgram,local' }), ['mistral', 'deepgram']);
  const rungs = Object.fromEntries(audio.cloudProviders({ env: { ...env, TRANSCRIBE_PROVIDERS: 'elevenlabs,assemblyai,deepgram,mistral,local' } }).map((r) => [r.name, r]));
  assert.equal(rungs.elevenlabs.model, 'scribe_v2');
  assert.equal(rungs.elevenlabs.escalation, undefined, 'in the order it is a first-pass rung');
  assert.equal(rungs.elevenlabs.envName, 'ELEVENLABS_API_KEY');
  assert.equal(rungs.assemblyai.model, 'universal');
  assert.equal(rungs.deepgram.model, 'nova-3');
  assert.equal(rungs.mistral.model, 'voxtral-mini-latest');
  assert.equal(typeof rungs.mistral.transcribeFile, 'function', 'Voxtral through its own multipart adapter, never the OpenAI SDK');
  assert.equal(rungs.mistral.caps.prompt, false);
  assert.ok(['assemblyai', 'deepgram', 'elevenlabs'].every((name) => typeof rungs[name].transcribeFile === 'function' && rungs[name].caps.prompt === false));
  assert.deepEqual(audio.escalationRungs({ env: { ...env, TRANSCRIBE_ESCALATION_PROVIDERS: 'elevenlabs' } }, [rungs.elevenlabs]), [], 'a first-pass rung is never repeated as escalation');
  assert.equal(audio.escalationRungs({ env: { ...env, TRANSCRIBE_ESCALATION_PROVIDERS: 'elevenlabs' } }, [rungs.deepgram])[0].escalation, true);
  for (const [name, flag] of [['elevenlabs', 'TRANSCRIBE_ELEVENLABS_DISABLED'], ['assemblyai', 'TRANSCRIBE_ASSEMBLYAI_DISABLED'], ['deepgram', 'TRANSCRIBE_DEEPGRAM_DISABLED'], ['mistral', 'TRANSCRIBE_MISTRAL_DISABLED']]) {
    assert.equal(names({ ...env, TRANSCRIBE_PROVIDERS: 'elevenlabs,assemblyai,deepgram,mistral', [flag]: '1' }).includes(name), false, flag);
  }
  assert.deepEqual(names({ TRANSCRIBE_PROVIDERS: 'elevenlabs,assemblyai,deepgram,mistral' }), [], 'no keys, no rungs');
});

test('ElevenLabs as the first rung reads every piece with speakers (Scribe v2, diarize on); TRANSCRIBE_ELEVENLABS_DIARIZE=0 and _KEYTERMS=1 are honoured', async (t) => {
  const eleven = elevenLabsFake('Hola a todos. Empezamos la clase de hoy.');
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { ELEVENLABS_API_KEY: 'el-test', TRANSCRIBE_PROVIDERS: 'elevenlabs' }, language: 'es', durationSeconds: 1800, elevenlabsClient: eleven, segmentAudio: segmenter(t, 3),
  });
  assert.deepEqual(result.providers, { elevenlabs: 3 });
  assert.equal(eleven.calls.length, 3, 'a first-pass rung reads every piece, not only flagged ones');
  assert.ok(eleven.calls.every((c) => c.modelId === 'scribe_v2' && c.diarize === true && c.languageCode === 'es' && c.keyterms === undefined), JSON.stringify(eleven.calls));
  assert.deepEqual([...new Set(result.segments.map((s) => s.speaker))], ['speaker_0', 'speaker_1'], 'speakers survive the stitch');
  assert.equal(result.quality.enginesUsed.includes('elevenlabs:scribe_v2'), true);
  const off = elevenLabsFake('Hola a todos. Empezamos la clase de hoy.');
  await audio.transcribe(tempFile(t, 'b.mp4'), 'video/mp4', 'b.mp4', {
    env: { ELEVENLABS_API_KEY: 'el-test', TRANSCRIBE_PROVIDERS: 'elevenlabs', TRANSCRIBE_ELEVENLABS_DIARIZE: '0', TRANSCRIBE_ELEVENLABS_KEYTERMS: '1' },
    language: 'es', durationSeconds: 1800, elevenlabsClient: off, segmentAudio: segmenter(t, 3), keyterms: ['Ñahui'],
  });
  assert.ok(off.calls.length >= 3 && off.calls.every((c) => c.diarize === false));
  assert.deepEqual(off.calls[0].keyterms, ['Ñahui']);
});

test('Mistral Voxtral goes through its own multipart adapter (the sttFetch seam): model, language, ONE timestamp_granularities field, no prompt', async (t) => {
  const calls = [];
  const sttFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const index = indexOf(init.body.get('file').name);
    return { ok: true, status: 200, headers: new Headers(), async json() { return { text: `voxtral ${index}`, language: 'es', segments: [{ start: 0, end: 2, text: `voxtral ${index}` }] }; } };
  };
  const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
    env: { MISTRAL_API_KEY: 'mi', TRANSCRIBE_PROVIDERS: 'mistral' }, language: 'es', prompt: 'Nombres: Ñahui', durationSeconds: 1200,
    sttFetch, createFile, segmentAudio: segmenter(t, 2),
  });
  assert.deepEqual(result.providers, { mistral: 2 });
  assert.equal(calls.length, 2);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.mistral.ai/v1/audio/transcriptions');
  assert.equal(init.headers.Authorization, 'Bearer mi');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'voxtral-mini-latest');
  assert.equal(init.body.get('language'), 'es');
  assert.deepEqual(init.body.getAll('timestamp_granularities'), ['segment'], 'one field per granularity, not the SDK array encoding');
  assert.equal(init.body.has('diarize'), false, 'speakers are opt-in (TRANSCRIBE_MISTRAL_DIARIZE=1)');
  assert.equal(init.body.has('prompt'), false);
  assert.deepEqual(result.segments.map((s) => s.start), [0, 600]);
  assert.equal(result.model, 'voxtral-mini-latest');
});

// ── round 2: bounded slot waits, governed short clips, lanes, cloudUsable ──

test('a provider paused by another job beyond the slot budget hands its pieces to the next rung at once (no wait, no failure); the last live rung waits the pause out', async (t) => {
  for (const scheduling of ['ladder', 'spread']) {
    const clock = fakeClock();
    const env = { OPENAI_API_KEY: 'sk-proj-TESTKEY_pool9', GROQ_API_KEY: 'gsk_pool9', TRANSCRIBE_PROVIDERS: 'openai,groq', TRANSCRIBE_SCHEDULING: scheduling };
    const governor = audio.governorFor({ env, now: clock.now, sleep: clock.sleep });
    governor.noteRateLimited('openai', 30 * 60_000); // another job's 429 with a daily quota: Retry-After 1800
    const openai = sdk(() => { throw new Error('openai must not be asked while paused'); });
    const groq = sdk((i) => ({ text: `groq ${i}`, segments: [] }));
    const result = await audio.transcribe(tempFile(t), 'video/mp4', 'clase.mp4', {
      env, language: 'es', durationSeconds: 1800, openai, groqClient: groq, createFile, segmentAudio: segmenter(t, 3), sleep: clock.sleep, now: clock.now,
      async localTranscribe() { throw new Error('local must not run'); },
    });
    assert.equal(result.partial, false, scheduling);
    assert.deepEqual(result.providers, { groq: 3 }, scheduling);
    assert.equal(openai.requests.length, 0, scheduling);
    assert.equal(clock.sleeps.includes(30 * 60_000), false, `${scheduling}: nobody waited the 30 min out`);
    assert.equal(governor.snapshot().openai.errors, 0, `${scheduling}: a refused slot is not a provider failure`);
    assert.equal(audio.cloudCapable({ env }), true, `${scheduling}: openai is still configured and not in cooldown`);
  }
  // The last live rung has no next rung: it waits, however long (a gap is worse).
  const clock = fakeClock();
  const env = { OPENAI_API_KEY: 'sk-proj-TESTKEY_pool10', TRANSCRIBE_PROVIDERS: 'openai' };
  audio.governorFor({ env, now: clock.now, sleep: clock.sleep }).noteRateLimited('openai', 30 * 60_000);
  const openai = sdk((i) => ({ text: `openai ${i}`, segments: [] }));
  const result = await audio.transcribe(tempFile(t, 'b.mp4'), 'video/mp4', 'b.mp4', {
    env, language: 'es', durationSeconds: 1200, openai, createFile, segmentAudio: segmenter(t, 2), sleep: clock.sleep, now: clock.now,
  });
  assert.deepEqual(result.providers, { openai: 2 });
  assert.equal(clock.sleeps[0], 30 * 60_000);
});

test('short clips take the same permits: a paused provider is skipped and a clip\'s 429 pauses the provider for the next clip', async (t) => {
  const clock = fakeClock();
  const env = { OPENAI_API_KEY: 'sk-proj-TESTKEY_pool11', GROQ_API_KEY: 'gsk_pool11', TRANSCRIBE_PROVIDERS: 'openai,groq' };
  const governor = audio.governorFor({ env, now: clock.now, sleep: clock.sleep });
  governor.noteRateLimited('openai', 30 * 60_000);
  const openai = sdk(() => { throw new Error('openai must not be asked while paused'); });
  const groq = sdk(() => ({ text: SENTENCE, segments: [] }));
  const first = await audio.transcribe(tempFile(t, 'nota.ogg'), 'audio/ogg', 'nota.ogg', {
    env, openai, groqClient: groq, sleep: clock.sleep, now: clock.now, ...clip(t), async localTranscribe() { throw new Error('local must not run'); },
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.providers, { groq: 1 });
  assert.equal(openai.requests.length, 0);
  assert.equal(governor.snapshot().groq.completed, 1, 'the clip\'s request went through the governor');

  // groq throttles a clip: the governor learns it (pause for the Retry-After), and the clip after that waits it out before asking groq again.
  const env2 = { GROQ_API_KEY: 'gsk_pool12', TRANSCRIBE_PROVIDERS: 'groq' };
  const clock2 = fakeClock();
  const gov2 = audio.governorFor({ env: env2, now: clock2.now, sleep: clock2.sleep });
  let throttled = false;
  const groq2 = sdk(() => {
    if (!throttled) { throttled = true; throw err(429, 'Too Many Requests', { headers: { 'retry-after': '45' } }); }
    return { text: SENTENCE, segments: [] };
  });
  const limited = await audio.transcribe(tempFile(t, 'a.ogg'), 'audio/ogg', 'a.ogg', { env: env2, groqClient: groq2, sleep: clock2.sleep, now: clock2.now, ...clip(t) });
  assert.equal(limited.ok, false);
  assert.equal(gov2.snapshot().groq.rateLimits, 1);
  assert.equal(gov2.capacity('groq').paused, true);
  const next = await audio.transcribe(tempFile(t, 'b.ogg'), 'audio/ogg', 'b.ogg', { env: env2, groqClient: groq2, sleep: clock2.sleep, now: clock2.now, ...clip(t) });
  assert.equal(next.ok, true);
  assert.deepEqual(clock2.sleeps, [45_000], 'the next clip waited the pause out on the governor\'s clock instead of hammering');
});

test('slot budgets by lane: dictation 10 s, voice notes 60 s, batch pieces the rate-limit wait; never above TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS', () => {
  assert.equal(audio.slotWaitMs({ env: {} }), 300_000);
  assert.equal(audio.slotWaitMs({ env: {}, lane: 'short' }), 60_000);
  assert.equal(audio.slotWaitMs({ env: {}, lane: 'interactive' }), 10_000);
  assert.equal(audio.slotWaitMs({ env: { TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS: '5000' }, lane: 'interactive' }), 5_000);
  assert.equal(audio.slotWaitMs({ env: { TRANSCRIBE_RATE_LIMIT_MAX_WAIT_MS: '120000' } }), 120_000);
});

test('admission: a lane job takes its reserved slot before the cloud pool, so the pool stays for batch jobs', async () => {
  const enqueue = audio._enqueueTranscription;
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const ctrl = new AbortController();
  process.env.TRANSCRIBE_CLOUD_CONCURRENCY = '1';
  try {
    const holds = [];
    for (let i = 0; i < audio.TRANSCRIPTION_CONCURRENCY; i++) { const h = deferred(); holds.push(h); enqueue(() => h.promise, ctrl.signal, null); }
    const shortHold = deferred();
    let shortStarted = false;
    const shortJob = enqueue(() => { shortStarted = true; return shortHold.promise; }, ctrl.signal, 'short', { cloud: true });
    await tick();
    assert.equal(shortStarted, true, 'a voice note with a cloud rung starts in its lane');
    const batchHold = deferred();
    let batchStarted = false;
    const batchJob = enqueue(() => { batchStarted = true; return batchHold.promise; }, ctrl.signal, null, { cloud: true });
    await tick();
    assert.equal(batchStarted, true, 'the only cloud slot was not spent on the lane job');
    shortHold.resolve('s');
    batchHold.resolve('b');
    for (const h of holds) h.resolve('x');
    await Promise.all([shortJob, batchJob]);
  } finally {
    delete process.env.TRANSCRIBE_CLOUD_CONCURRENCY;
  }
});

test('cloudUsable (the queue\'s autoscaler): a pool full with our own traffic is still usable; a provider paused by a 429, a key in cooldown or no key is not', async () => {
  assert.equal(audio.cloudUsable({ env: {} }), false);
  const env = { GROQ_API_KEY: 'gsk_usable', TRANSCRIBE_GROQ_IN_FLIGHT: '1' };
  const governor = audio.governorFor({ env });
  assert.equal(audio.cloudUsable({ env }), true);
  const held = await governor.acquire('groq');
  assert.equal(audio.cloudCapacityAvailable({ env }), false, 'no free slot this instant');
  assert.equal(audio.cloudUsable({ env }), true, 'but the provider is usable: scaling the queue up still helps');
  held.release('ok');
  governor.noteRateLimited('groq', 30_000);
  assert.equal(audio.cloudUsable({ env }), false, 'paused by a 429: more work would only queue');
  const cold = { GROQ_API_KEY: 'gsk_cold' };
  keyHealth.markRejected('transcribe:groq', 'gsk_cold', Object.assign(new Error('bad key'), { status: 401 }), cold);
  assert.equal(audio.cloudUsable({ env: cold }), false);
});

test('a whole-file whisper.cpp read (short clip, local only) shares the long jobs\' cap; the reserved lanes keep their own slots', async (t) => {
  const run = async (lane) => {
    let active = 0;
    let peak = 0;
    const env = { TRANSCRIBE_PROVIDERS: 'local', TRANSCRIBE_LOCAL_PARALLEL_TOTAL: '1' };
    const opts = () => ({
      env, language: 'es', durationSeconds: 20, ffmpegFilters: [], ...(lane ? { lane } : {}),
      async localTranscribe() {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { text: SENTENCE };
      },
    });
    await Promise.all([
      audio.transcribe(tempFile(t, 'a.ogg'), 'audio/ogg', 'a.ogg', opts()),
      audio.transcribe(tempFile(t, 'b.ogg'), 'audio/ogg', 'b.ogg', opts()),
    ]);
    return peak;
  };
  assert.equal(await run(null), 1, 'two whole-file reads, one shared cap');
  assert.equal(await run('short'), 2, 'the short lane is exempt');
});
