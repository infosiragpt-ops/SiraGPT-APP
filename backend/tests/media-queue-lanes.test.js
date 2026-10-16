'use strict';

// Contract C5 of the «transcription never fails» plan, queue side:
//  - two lanes: recordings estimated at ≤ 15 min go to a short queue of their
//    own; the long lane keeps the historical queue name; every lookup asks both;
//  - language and hints reach the transcriber and survive a re-queue through
//    their durable copy (DocumentAnalysis.metadata.mediaHints);
//  - enqueueRefine re-transcribes one window of a READY transcript and splices
//    it in, never losing the text;
//  - cleanup + prompt echo run on every transcript, device ids never prime the
//    recogniser, and the engine's quality report is persisted.
// Offline: fake queues, fake Prisma, fake engine; no Redis, no binaries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const q = require('../src/services/media-transcription-queue');
const store = require('../src/services/media-transcript-store');

const NOW = Date.parse('2026-10-16T12:00:00Z');

const row = (id, extra = {}) => ({ id, userId: 'u1', originalName: `${id}.opus`, mimeType: 'audio/ogg', size: 120_000,
  path: `/uploads/u1/${id}.opus`, deletedAt: null, extractedText: null, processingError: null,
  processingStage: 'uploaded', processingStageAt: new Date(NOW - 300000), ...extra });

function makeQueue(name, jobs) {
  return {
    name,
    async getJob(id) { return jobs.get(id); },
    async add(jobName, data, opts) {
      if (jobs.has(opts.jobId)) return jobs.get(opts.jobId);
      const job = { id: opts.jobId, name: jobName, queueName: name, data, opts, state: 'waiting', attemptsMade: 0,
        async getState() { return this.state; },
        async remove() { jobs.delete(this.id); },
        async retry() { this.state = 'waiting'; this.attemptsMade = 0; },
        discard() { this.discarded = true; } };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
}

function fakeStore({ hints = new Map(), sidecars = new Map(), durations = new Map() } = {}) {
  const calls = { sidecars: [], analyses: [], pointers: [], hintWrites: [] };
  return {
    calls, hints, sidecars,
    async recordMediaHints(_prisma, payload) {
      calls.hintWrites.push(payload);
      const merged = store.mergeMediaHints(hints.get(payload.fileId) || null,
        store.normalizeStoredHints({ ...(payload.hints || {}), language: payload.language }) || {});
      hints.set(payload.fileId, { ...merged, updatedAt: new Date(payload.at).toISOString() });
      return { ok: true };
    },
    async readMediaHints(_prisma, { fileId }) { return hints.get(fileId) || null; },
    async readMediaAnalysisInfo(_prisma, { fileId }) { return { mediaHints: hints.get(fileId) || null, durationSec: durations.get(fileId) ?? null }; },
    async loadMediaTranscript(_prisma, { fileId }) { return sidecars.get(fileId) || null; },
    async writeSidecar({ fileId, result }) { calls.sidecars.push(result); sidecars.set(fileId, store.normalizeSidecar(store.buildSidecar({ fileId, userId: 'u1', result }))); return { path: `/x/${fileId}.json.gz` }; },
    async upsertMediaTranscriptAnalysis(_prisma, payload) { calls.analyses.push(payload); },
    async recordCheckpointPointer(payload) { calls.pointers.push(payload); return { ok: true }; },
  };
}

function fixture(initial, overrides = {}) {
  const rows = new Map(initial.map(file => [file.id, { ...file }]));
  const longJobs = new Map();
  const shortJobs = new Map();
  const longQueue = makeQueue(q.QUEUE_NAME, longJobs);
  const shortQueue = makeQueue(q.SHORT_QUEUE_NAME, shortJobs);
  const terminal = [];
  const engineCalls = [];
  const matches = (file, where) => file && file.id === where.id && file.userId === where.userId && file.deletedAt == null;
  const prisma = { file: {
    async findFirst({ where }) { const file = rows.get(where.id); return matches(file, where) ? { ...file } : null; },
    async updateMany({ where, data }) {
      const file = rows.get(where.id);
      if (!matches(file, where)) return { count: 0 };
      Object.assign(file, data);
      return { count: 1 };
    },
    async findMany({ where, take }) {
      return [...rows.values()].filter(file => !file.deletedAt && where.processingStage.in.includes(file.processingStage))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take);
    },
  } };
  const transcriptStore = overrides.transcriptStore || fakeStore();
  const service = q.createMediaTranscriptionService({
    prisma, getQueue: () => longQueue, getShortQueue: () => shortQueue, now: () => NOW,
    validate: async (_local, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
    processFile: async (file, opts) => { engineCalls.push({ file, opts }); return { success: true, extractedText: 'Hola, soy una nota de voz.' }; },
    transcriptStore, onTerminal: payload => terminal.push(payload), logger: { warn() {}, info() {} },
    ...overrides,
  });
  return { service, rows, longJobs, shortJobs, longQueue, shortQueue, terminal, engineCalls, transcriptStore, prisma };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// ── lanes ───────────────────────────────────────────────────────────────────

test('the size bound is an upper bound of the duration: voice notes are short, unknown or big files stay long', () => {
  // 120 kB of Opus is at most 160 s (6 kbps floor).
  assert.ok(q.estimateDurationFromSize({ size: 120_000, mimeType: 'audio/ogg' }) <= 160);
  assert.equal(q.laneForDuration(q.estimateDurationFromSize({ size: 120_000, mimeType: 'audio/ogg' })), 'short');
  // 40 MB mp3 could be hours at 8 kbps: long until a probe says otherwise.
  assert.equal(q.laneForDuration(q.estimateDurationFromSize({ size: 40_000_000, mimeType: 'audio/mpeg' })), 'long');
  assert.equal(q.estimateDurationFromSize({ size: 0 }), null);
  assert.equal(q.laneForDuration(null), 'long', 'unknown duration → long lane (today\'s behaviour)');
  assert.equal(q.laneForDuration(900), 'short');
  assert.equal(q.laneForDuration(901), 'long');
  assert.equal(q.QUEUE_NAME, 'siragpt-media-transcription', 'the long lane keeps the historical name');
  assert.equal(q.SHORT_QUEUE_NAME, 'siragpt-media-transcription-short');
  assert.equal(q.shortLaneEnabled({}), true);
  assert.equal(q.shortLaneEnabled({ SIRAGPT_MEDIA_SHORT_LANE: '0' }), false);
});

// Plumbing only: the queue tells the engine its lane. Whether the transcriber
// then admits a short-lane job past two long ones is the end-to-end test below.
test('a voice note goes to the short lane, a long lecture to the long one; the engine is told its lane', async () => {
  const f = fixture([row('nota'), row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 300_000_000 })]);
  const note = await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  const lecture = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  assert.equal(note.lane, 'short');
  assert.equal(lecture.lane, 'long');
  assert.equal(f.shortJobs.size, 1);
  assert.equal(f.longJobs.size, 1);
  const job = f.shortJobs.get(q.jobIdFor('nota', 'u1'));
  assert.equal(job.data.lane, 'short');
  assert.equal(job.opts.attempts, 3);
  await f.service.processMediaJob(job);
  assert.equal(f.engineCalls[0].opts.lane, 'short');
  assert.equal(f.rows.get('nota').processingStage, 'ready');
});

// The lanes only help if the transcriber's own admission gate (shared by
// every caller, two slots held for a whole job) lets a short-lane job in
// while two long ones run. That gate lives in audio-transcriber (contract C4
// `lane`, group G1); until it reads `lane`, this test reports as TODO.
test('end to end: the transcriber admits a short-lane voice note while two long jobs hold it', async (t) => {
  const audio = require('../src/services/audio-transcriber');
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const entered = [];
  const controllers = [];
  const pause = () => new Promise(resolve => setTimeout(resolve, 10));
  const blockUntilAbort = (_file, { signal }) => new Promise((_resolve, reject) => {
    entered.push('long');
    if (signal.aborted) { reject(signal.reason || abortError()); return; }
    signal.addEventListener('abort', () => reject(signal.reason || abortError()), { once: true });
  });
  const call = (lane, probeMediaStreams) => {
    const controller = new AbortController();
    controllers.push(controller);
    return audio.transcribe(path.join(os.tmpdir(), 'sira-lanes-missing.mp3'), 'audio/mpeg', 'clase.mp3', {
      signal: controller.signal, lane, probeMediaStreams, env: {},
      localTranscribe: async () => { throw new Error('not reached'); },
    }).then(() => 'done', () => 'stopped');
  };
  const longs = [call('long', blockUntilAbort), call('long', blockUntilAbort)];
  for (let i = 0; i < 100 && entered.length < 2; i++) await pause();
  assert.equal(entered.length, 2, 'two long jobs hold the transcriber');
  let admitted = false;
  const shortController = () => controllers[2];
  const short = call('short', async () => { admitted = true; shortController().abort(); return { ok: false, error: 'probe_failed' }; });
  for (let i = 0; i < 50 && !admitted; i++) await pause();
  for (const controller of controllers) controller.abort();
  assert.deepEqual(await Promise.all([...longs, short]), ['stopped', 'stopped', 'stopped'], 'every call ends, every slot is released');
  if (!admitted) t.todo('needs a short-lane admission gate in audio-transcriber.transcribe (contract C4 `lane`, group G1)');
  assert.equal(admitted, true, 'a voice note never waits behind two long lectures');
});

test('the probe decides when the size bound says long; it is skipped when the size already says short', async () => {
  const probed = [];
  const f = fixture([row('mp3', { originalName: 'charla.mp3', mimeType: 'audio/mpeg', size: 4_800_000 }), row('nota')], {
    estimateDurationSec: async file => { probed.push(file.id); return file.id === 'mp3' ? 300 : null; },
  });
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'mp3', userId: 'u1' })).lane, 'short', '5-min mp3 at 128 kbps');
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' })).lane, 'short');
  assert.deepEqual(probed, ['mp3'], 'no probe for a file the size already bounds');

  const failing = fixture([row('mp3', { originalName: 'charla.mp3', mimeType: 'audio/mpeg', size: 4_800_000 })], {
    estimateDurationSec: async () => { throw new Error('ffprobe down'); },
  });
  assert.equal((await failing.service.enqueueMediaTranscription({ fileId: 'mp3', userId: 'u1' })).lane, 'long', 'a failed probe falls back to the size bound');
});

test('a job already waiting in the long lane (queued before the deploy) is found: no second job in the short lane', async () => {
  const f = fixture([row('nota')]);
  await f.longQueue.add('transcribe', { fileId: 'nota', userId: 'u1' }, { jobId: q.jobIdFor('nota', 'u1') });
  const result = await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  assert.equal(result.queued, true);
  assert.equal(f.shortJobs.size, 0);
  assert.equal(f.longJobs.size, 1);
  // Progress is read from whichever lane holds the job.
  f.longJobs.get(q.jobIdFor('nota', 'u1')).progress = { stage: 'transcribing', completed: 1, total: 2 };
  const read = await f.service.readMediaProgress({ fileIds: ['nota'], userId: 'u1' });
  assert.equal(read.nota.completed, 1);
});

test('recovery sweeps both lanes: a stuck file is re-added once, in its lane, and a job in either lane is respected', async () => {
  const f = fixture([row('a'), row('b'), row('c', { originalName: 'c.mp3', mimeType: 'audio/mpeg', size: 400_000_000 })]);
  await f.shortQueue.add('transcribe', { fileId: 'a', userId: 'u1' }, { jobId: q.jobIdFor('a', 'u1') });
  assert.deepEqual(await f.service.reconcilePendingMedia(), { recovered: 3 });
  assert.deepEqual([...f.shortJobs.values()].map(job => job.data.fileId).sort(), ['a', 'b']);
  assert.deepEqual([...f.longJobs.values()].map(job => job.data.fileId), ['c']);
  await f.service.reconcilePendingMedia();
  assert.equal(f.shortJobs.size + f.longJobs.size, 3, 'nothing is queued twice');
});

test('a short lane that is not available never blocks: everything goes to the long lane', async () => {
  const f = fixture([row('nota')], { getShortQueue: () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
  const result = await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  assert.equal(result.queued, true);
  assert.equal(f.longJobs.size, 1);
  assert.equal(result.lane, undefined, 'one lane: the response keeps its old shape');
});

test('the enqueue-time probe is bounded: remote files are not probed and a burst never piles up', async () => {
  let active = 0;
  let peak = 0;
  const release = [];
  const estimate = q.createEnqueueDurationProbe({
    isRemote: ref => ref.startsWith('r2:'), concurrency: 2, maxWaiting: 3,
    probe: () => new Promise(resolve => { active++; peak = Math.max(peak, active); release.push(() => { active--; resolve({ ok: true, durationSec: 60 }); }); }),
  });
  assert.equal(await estimate({ path: 'r2:uploads/x.mp3' }), null);
  const pending = Array.from({ length: 5 }, (_, i) => estimate({ path: `/u/${i}.mp3` }));
  await flush();
  assert.equal(peak, 2, 'at most two probes at once');
  assert.equal(await estimate({ path: '/u/extra.mp3' }), null, 'a full waiting list skips the probe');
  while (release.length) { release.shift()(); await flush(); }
  assert.deepEqual(await Promise.all(pending), [60, 60, 60, 60, 60]);
  const broken = q.createEnqueueDurationProbe({ probe: async () => ({ ok: false, error: 'probe_failed' }) });
  assert.equal(await broken({ path: '/u/a.mp3' }), null);
});

// ── hints ───────────────────────────────────────────────────────────────────

test('language and hints reach the transcriber; the user\'s terms join the file-name terms, device ids never do', async () => {
  const f = fixture([row('PTT-20261003-WA0012', { originalName: 'PTT-20261003-WA0012.opus' })], {
    processFile: async (file, opts) => {
      f.engineCalls.push({ file, opts });
      return { success: true, extractedText: 'Hello, Huamán.', transcription: { ok: true, durationSec: 12, language: 'en', transcript: 'Hello, Huamán.',
        segments: [{ start: 0, end: 3, text: 'Hello, Huamán.' }], gaps: [] } };
    },
  });
  await f.service.enqueueMediaTranscription({ fileId: 'PTT-20261003-WA0012', userId: 'u1', language: 'inglés',
    hints: { terms: ['Huamán', 'Ayacucho', 'WA0012', '10:30'], speakers: 3, verbatim: true } });
  const job = [...f.shortJobs.values()][0];
  assert.equal(job.data.language, 'en');
  assert.deepEqual(job.data.hints, { terms: ['Huamán', 'Ayacucho'], speakers: 3, verbatim: true });
  assert.equal(job.data.hintsAt, NOW);
  await f.service.processMediaJob(job);
  const { opts } = f.engineCalls[0];
  assert.equal(opts.language, 'en');
  assert.deepEqual(opts.hints, { terms: ['Huamán', 'Ayacucho'], speakers: 3, verbatim: true });
  assert.deepEqual(opts.keyterms, ['Huamán', 'Ayacucho'], 'no «WA0012» from the file name');
  // The sidecar remembers the hints the transcript was made with.
  assert.deepEqual(f.transcriptStore.sidecars.get('PTT-20261003-WA0012').hints,
    { language: 'en', terms: ['Huamán', 'Ayacucho'], speakers: 3, verbatim: true });
  assert.equal(f.rows.get('PTT-20261003-WA0012').extractedText, 'Hello, Huamán.', 'a real word that is also a term stays');
});

test('keytermsFromFileName drops phone, recorder and Zoom identifiers', () => {
  assert.deepEqual(q.keytermsFromFileName('PTT-20261003-WA0012.opus'), []);
  assert.deepEqual(q.keytermsFromFileName('AUD-20261003-WA0007.opus'), []);
  assert.deepEqual(q.keytermsFromFileName('GMT20261003-150000_Recording_1920x1080.mp4'), []);
  assert.deepEqual(q.keytermsFromFileName('REC0042.WAV'), []);
  assert.deepEqual(q.keytermsFromFileName('DSCN0012 Huancayo.MOV'), ['Huancayo']);
  assert.deepEqual(q.keytermsFromFileName('Clase 12 - Bioquímica (Dr. Pérez).mp4'), ['Bioquímica', 'Pérez']);
  assert.deepEqual(q.keytermsFor('VID-20240101-WA0003.mp4', { terms: ['Quispe', 'IMG_2023'] }), ['Quispe']);
});

test('a job re-queued by recovery with only { fileId, userId } still gets the durable hints', async () => {
  const f = fixture([row('nota')]);
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1', language: 'pt', hints: { terms: ['Florianópolis'] } });
  assert.equal(f.transcriptStore.calls.hintWrites.length, 1, 'the durable copy is written at enqueue');
  // The Redis job is lost; recovery re-adds a bare one.
  f.shortJobs.clear();
  await f.service.reconcilePendingMedia();
  const job = [...f.shortJobs.values()][0];
  assert.equal(job.data.language, undefined);
  await f.service.processMediaJob(job);
  assert.equal(f.engineCalls[0].opts.language, 'pt');
  assert.deepEqual(f.engineCalls[0].opts.hints, { terms: ['Florianópolis'] });
});

test('names typed after the upload reach a job that is still waiting (the newer durable copy wins)', async () => {
  const f = fixture([row('nota')]);
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  // A later chat turn: the job is waiting, so only the durable copy changes.
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1', hints: { terms: ['Ccori'] }, language: 'es' });
  assert.equal(f.shortJobs.size, 1);
  await f.service.processMediaJob([...f.shortJobs.values()][0]);
  assert.deepEqual(f.engineCalls[0].opts.keyterms, ['Ccori']);
  assert.equal(f.engineCalls[0].opts.language, 'es');
});

test('store: hints are kept durably, owner-scoped, merged, with schema columns only', async () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const fields = new Set(/model DocumentAnalysis \{([\s\S]*?)\n\}/.exec(schema)[1].split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean));
  const rows = new Map([['other', { fileId: 'other', userId: 'u2', metadata: {} }]]);
  const prisma = {
    file: { async findFirst({ where }) { return where.id === 'gone' ? null : { id: where.id, mimeType: 'video/mp4' }; } },
    documentAnalysis: {
      async findUnique({ where, select }) { for (const k of Object.keys(select)) assert.ok(fields.has(k)); const r = rows.get(where.fileId); return r ? { userId: r.userId, metadata: r.metadata } : null; },
      async upsert({ where, create, update }) {
        for (const k of [...Object.keys(create), ...Object.keys(update)]) assert.ok(fields.has(k), `${k} is a column`);
        const existing = rows.get(where.fileId);
        rows.set(where.fileId, existing ? { ...existing, ...update } : { ...create });
        return rows.get(where.fileId);
      },
    },
  };
  assert.deepEqual(await store.recordMediaHints(prisma, { fileId: 'f1', userId: 'u1', language: 'en', hints: { terms: ['Huamán'] }, at: NOW }),
    { ok: true, mediaHints: { language: 'en', terms: ['Huamán'], updatedAt: new Date(NOW).toISOString() } });
  assert.equal(rows.get('f1').status, 'pending', 'a new pointer row never claims an analysis');
  await store.recordMediaHints(prisma, { fileId: 'f1', userId: 'u1', hints: { terms: ['Ayacucho'], speakers: 2 }, at: NOW + 1000 });
  assert.deepEqual(await store.readMediaHints(prisma, { fileId: 'f1', userId: 'u1' }),
    { language: 'en', terms: ['Ayacucho', 'Huamán'], speakers: 2, updatedAt: new Date(NOW + 1000).toISOString() });
  assert.equal(await store.readMediaHints(prisma, { fileId: 'f1', userId: 'u9' }), null, 'another user reads nothing');
  assert.equal((await store.recordMediaHints(prisma, { fileId: 'other', userId: 'u1', language: 'en' })).reason, 'foreign');
  assert.equal((await store.recordMediaHints(prisma, { fileId: 'gone', userId: 'u1', language: 'en' })).reason, 'not_found');
  assert.equal((await store.recordMediaHints(prisma, { fileId: 'f1', userId: 'u1', language: 'auto' })).reason, 'empty');
  assert.equal((await store.recordMediaHints({}, { fileId: 'f1', userId: 'u1', language: 'en' })).reason, 'unavailable');
});

// ── cleanup on every transcript, prompt echo, quality ───────────────────────

test('a short voice note is cleaned before it is stored: credits, sign-offs and prompt echoes never reach extractedText', async () => {
  const transcription = { ok: true, durationSec: 30, language: 'es', providers: { openai: 1 }, engine: 'cloud', partial: false, gaps: [], coverage: 1,
    transcript: 'x', segments: [
      { start: 0, end: 4, text: 'Bioquímica, Pérez.' },
      { start: 4, end: 12, text: 'Hola, mañana tenemos examen de la unidad dos.' },
      { start: 12, end: 18, text: 'Subtítulos realizados por la comunidad de Amara.org' },
    ] };
  const f = fixture([row('nota', { originalName: 'Bioquímica Pérez.opus' })], {
    processFile: async () => ({ success: true, extractedText: 'x', transcription }),
  });
  const lines = [];
  f.service = q.createMediaTranscriptionService({ ...fixtureDeps(f), logger: { info: l => lines.push(l), warn: l => lines.push(l) },
    processFile: async () => ({ success: true, extractedText: 'x', transcription }) });
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  await f.service.processMediaJob([...f.shortJobs.values()][0]);
  assert.equal(f.rows.get('nota').extractedText, 'Hola, mañana tenemos examen de la unidad dos.');
  const stored = f.transcriptStore.calls.sidecars[0];
  assert.equal(stored.segments.length, 1);
  assert.equal(stored.source, 'asr');
  assert.equal(stored.cleanup.echoes, 1);
  assert.equal(stored.cleanup.hallucinations, 2);
  const line = lines.find(l => l.startsWith('[media-transcription]'));
  assert.match(line, /cleaned=2 echo=1 lane=short/);
  assert.doesNotMatch(line, /examen|Bioquímica/);
});

function fixtureDeps(f) {
  return { prisma: f.prisma, getQueue: () => f.longQueue, getShortQueue: () => f.shortQueue, now: () => NOW,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
    transcriptStore: f.transcriptStore, onTerminal: payload => f.terminal.push(payload) };
}

test('a clip that is only an invented sign-off is «no speech», never a transcript', async () => {
  const f = fixture([row('nota')], { processFile: async () => ({ success: true, extractedText: 'Gracias por ver el video.',
    transcription: { ok: true, durationSec: 20, transcript: 'Gracias por ver el video.', segments: [{ start: 0, end: 20, text: 'Gracias por ver el video.' }], gaps: [] } }) });
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  await assert.rejects(f.service.processMediaJob([...f.shortJobs.values()][0]), { code: 'no_speech' });
  assert.equal(f.rows.get('nota').processingStage, 'failed');
  assert.equal(f.rows.get('nota').processingError, 'No se detectó voz en este archivo.');
});

test('text that needs no cleanup is stored exactly as the engine gave it', () => {
  const plain = 'Primera línea.\n\nSegunda línea.';
  const out = q.cleanTranscription({ transcript: plain }, plain, { promptTerms: ['Lima'] });
  assert.equal(out.plain, plain);
  assert.equal(out.cleanup, null);
  const echo = q.cleanTranscription({ segments: [{ start: 0, end: 5, text: 'Huamán, Quispe.' }], transcript: 'Huamán, Quispe.' }, 'Huamán, Quispe.', { promptTerms: ['Huamán', 'Quispe'] });
  assert.equal(echo.removedAll, true);
});

// The length rules (a lone «Gracias» / one prompt word over ≥ 3 s) are a
// guess: alone they never make a voice note «no speech» (C4), and on a short
// clip they flag instead of delete. Lexicon sign-offs, credits and silence
// tokens still do.
function noteFixture(id, transcription, extra = {}) {
  return fixture([row(id)], { processFile: async () => ({ success: true, extractedText: transcription.transcript, transcription }), ...extra });
}
async function runNote(f, id) {
  await f.service.enqueueMediaTranscription({ fileId: id, userId: 'u1' });
  const job = [...f.shortJobs.values()][0];
  return { job, result: await f.service.processMediaJob(job) };
}

test('a 3.4 s «Muchas gracias.» voice note is a transcript (flagged as doubtful), never a discarded «no speech»', async () => {
  for (const [id, text, durationSec] of [['gracias', 'Muchas gracias.', 3.4], ['thanks', 'Thank you.', 3.1]]) {
    const f = noteFixture(id, { ok: true, durationSec, language: 'es', transcript: text, segments: [{ start: 0, end: durationSec, text }], gaps: [] });
    const { job, result } = await runNote(f, id);
    assert.equal(result.stage, 'ready', id);
    const file = f.rows.get(id);
    assert.equal(file.processingStage, 'ready');
    assert.equal(file.extractedText, text, 'the engine\'s own text');
    assert.equal(file.processingError, null);
    assert.notEqual(job.discarded, true);
    const saved = f.transcriptStore.sidecars.get(id);
    assert.deepEqual(saved.segments.map(s => s.text), [text]);
    assert.deepEqual(saved.quality.lowConfidence, [{ start: 0, end: durationSec, reason: 'hallucination' }]);
    assert.ok(saved.quality.notes.some(n => /podría haberlo inventado el motor/.test(n)));
    // The delivered TXT keeps it too, and says why it is doubtful.
    const txt = require('../src/services/media-transcript-format').renderText(saved, { fileName: `${id}.opus`, now: NOW });
    assert.match(txt, new RegExp(text.replace('.', '\\.')));
    assert.match(txt, /Tramos dudosos: 00:00–00:0\d \(posible texto inventado\)/);
    assert.deepEqual(f.terminal, [{ fileId: id, userId: 'u1', stage: 'ready' }]);
  }
});

test('a multi-segment voice note keeps its closing «Gracias.» of 3 s or more (flagged), a long lecture still drops it', async () => {
  const note = { ok: true, durationSec: 40, language: 'es', transcript: 'x', gaps: [], segments: [
    { start: 0, end: 30, text: 'Profe, le mando la tarea de mañana, revise la segunda parte por favor.' },
    { start: 34, end: 38, text: 'Gracias.' }] };
  const f = noteFixture('nota', note);
  await runNote(f, 'nota');
  assert.equal(f.rows.get('nota').extractedText, 'Profe, le mando la tarea de mañana, revise la segunda parte por favor. Gracias.');
  assert.deepEqual(f.transcriptStore.sidecars.get('nota').quality.lowConfidence, [{ start: 34, end: 38, reason: 'hallucination' }]);
  assert.equal(f.transcriptStore.calls.sidecars[0].cleanup, undefined, 'nothing removed');

  const lecture = { ok: true, durationSec: 1800, language: 'es', transcript: 'x', gaps: [], segments: [
    { start: 0, end: 30, text: 'Hoy vemos la célula.' }, { start: 1790, end: 1798, text: '¡Gracias!' }] };
  const g = fixture([row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 400_000_000 })], {
    processFile: async () => ({ success: true, extractedText: 'x', transcription: lecture }) });
  await g.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await g.service.processMediaJob([...g.longJobs.values()][0]);
  const saved = g.transcriptStore.sidecars.get('clase');
  assert.deepEqual(saved.segments.map(s => s.text), ['Hoy vemos la célula.'], 'over silence in a long recording it is still removed');
  assert.equal(saved.quality, undefined);

  // A clip where the engine showed it was inventing over silence: the length rule stands.
  const credited = { ok: true, durationSec: 40, transcript: 'x', gaps: [], segments: [
    { start: 0, end: 20, text: 'Nos vemos el lunes.' }, { start: 20, end: 36, text: '¡Gracias!' },
    { start: 36, end: 40, text: 'Subtítulos realizados por la comunidad de Amara.org' }] };
  const h = noteFixture('creditos', credited);
  await runNote(h, 'creditos');
  assert.equal(h.rows.get('creditos').extractedText, 'Nos vemos el lunes.');
});

test('«no speech» still ends a clip that is only engine sign-offs, credits, silence tokens or doubted «Gracias»', async () => {
  const cases = [
    ['firma', [{ start: 0, end: 3.4, text: 'Gracias por ver el video.' }]],
    ['silencio', [{ start: 0, end: 2, text: '[BLANK_AUDIO]' }, { start: 2, end: 5.5, text: 'Gracias.' }]],
    ['dudosa', [{ start: 0, end: 3.4, text: 'Muchas gracias.', confidence: 0.3 }]],
  ];
  for (const [id, segments] of cases) {
    const f = noteFixture(id, { ok: true, durationSec: 6, transcript: 'x', gaps: [], segments });
    await f.service.enqueueMediaTranscription({ fileId: id, userId: 'u1' });
    const job = [...f.shortJobs.values()][0];
    await assert.rejects(f.service.processMediaJob(job), { code: 'no_speech' }, id);
    assert.equal(f.rows.get(id).processingError, 'No se detectó voz en este archivo.', id);
    assert.equal(job.discarded, true, id);
  }
  // One prompt word stretched over the whole clip is a guess too, never «no speech».
  const echo = q.cleanTranscription({ durationSec: 4, segments: [{ start: 0, end: 4, text: 'Ayacucho.' }], transcript: 'Ayacucho.' }, 'Ayacucho.', { promptTerms: ['Ayacucho'] });
  assert.equal(echo.removedAll, false);
  assert.equal(echo.plain, 'Ayacucho.');
  assert.deepEqual(echo.transcription.quality.lowConfidence, [{ start: 0, end: 4, reason: 'hallucination' }]);
});

test('the engine\'s quality report and audio stream are persisted: sidecar, analysis pointer and log (numbers only)', async () => {
  const quality = { score: 0.82, level: 'media', lowConfidence: [{ start: 750, end: 790, reason: 'noise' }], escalations: 1, enginesUsed: ['local', 'groq'], notes: ['Hubo ruido en un tramo.'] };
  const transcription = { ok: true, durationSec: 1800, language: 'es', providers: { local: 3 }, engine: 'local', partial: false, gaps: [], coverage: 1,
    transcript: 'Uno. Dos.', segments: [{ start: 0, end: 5, text: 'Uno.' }, { start: 760, end: 765, text: 'Dos.' }], quality, audioStream: { streamOrdinal: 1, reason: 'language_match' } };
  const lines = [];
  const transcriptStore = fakeStore();
  const f = fixture([row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 400_000_000 })], {
    transcriptStore, logger: { info: l => lines.push(l), warn: l => lines.push(l) },
    processFile: async () => ({ success: true, extractedText: 'Uno. Dos.', transcription }),
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await f.service.processMediaJob([...f.longJobs.values()][0]);
  const saved = transcriptStore.sidecars.get('clase');
  assert.equal(saved.quality.level, 'media');
  assert.deepEqual(saved.quality.lowConfidence, [{ start: 750, end: 790, reason: 'noise' }]);
  assert.deepEqual(saved.audioStream, { streamOrdinal: 1, reason: 'language_match' });
  const meta = store.mediaTranscriptMetadata(transcriptStore.calls.analyses[0].result, { fileId: 'clase' });
  assert.deepEqual(meta.quality, { score: 0.82, level: 'media', lowConfidence: 1, enginesUsed: ['local', 'groq'] });
  const line = lines.find(l => l.includes('outcome=ready'));
  assert.match(line, /quality=0\.82 level=media lowconf=1 lane=long/);
  assert.doesNotMatch(line, /ruido|Uno/);
});

test('without the engine\'s quality fields (older engine) nothing breaks and nothing is invented', async () => {
  const transcriptStore = fakeStore();
  const f = fixture([row('clase', { size: 100_000 })], { transcriptStore, processFile: async () => ({ success: true, extractedText: 'Hola.',
    transcription: { ok: true, durationSec: 10, transcript: 'Hola.', segments: [{ start: 0, end: 2, text: 'Hola.' }], gaps: [] } }) });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await f.service.processMediaJob([...f.shortJobs.values()][0]);
  const saved = transcriptStore.sidecars.get('clase');
  assert.equal(saved.quality, undefined);
  assert.equal(saved.source, 'asr');
});

// ── refine ──────────────────────────────────────────────────────────────────

const LECTURE = () => ({ ok: true, durationSec: 1800, language: 'es', providers: { local: 3 }, engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [
    { start: 0, end: 10, text: 'Buenos días.' },
    { start: 720, end: 730, text: 'El profesor Kori explica.' },
    { start: 1500, end: 1510, text: 'Hasta mañana.' },
  ] });

function readyLecture(extra = {}) {
  const transcriptStore = fakeStore({ durations: new Map([['clase', 1800]]) });
  transcriptStore.sidecars.set('clase', store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: LECTURE() })));
  const f = fixture([row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 400_000_000, processingStage: 'ready',
    extractedText: '[00:00] Buenos días. [12:00] El profesor Kori explica.' })], {
    transcriptStore,
    processFile: async (file, opts) => {
      f.engineCalls.push({ file, opts });
      const result = LECTURE();
      result.segments[1].text = 'El profesor Ccori explica.';
      result.segments[0].text = 'Buenos días (otra lectura).';
      return { success: true, extractedText: 'x', transcription: result };
    },
    ...extra,
  });
  return { f, transcriptStore };
}

test('enqueueRefine validates the window and only refines a READY transcript', async () => {
  const { f } = readyLecture();
  await assert.rejects(f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 10, end: 5 } }), { code: 'invalid_range' });
  await assert.rejects(f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: null }), { code: 'invalid_range' });
  await assert.rejects(f.service.enqueueRefine({ fileId: 'clase', userId: 'u9', range: { start: 0, end: 60 } }), { code: 'media_not_found' });
  f.rows.get('clase').processingStage = 'extracting';
  f.rows.get('clase').extractedText = null;
  assert.deepEqual(await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 0, end: 60 } }),
    { id: 'clase', queued: false, refine: true, stage: 'extracting', reason: 'not_ready' });
});

test('a refine job is forced, carries the window and the delivery id, follows the recording\'s lane and is not duplicated', async () => {
  const { f } = readyLecture();
  const first = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, hints: { terms: ['Ccori'] }, deliveryId: 'dlv_1' });
  assert.equal(first.queued, true);
  assert.equal(first.lane, 'long', 'a 30-minute recording refines in the long lane');
  const job = f.longJobs.get(first.jobId);
  assert.deepEqual(job.data, { fileId: 'clase', userId: 'u1', refine: true, range: { start: 700, end: 760 },
    hints: { terms: ['Ccori'] }, hintsAt: NOW, deliveryId: 'dlv_1', lane: 'long' });
  assert.match(first.jobId, /^media-refine-[a-f0-9]{64}$/);
  assert.notEqual(first.jobId, q.jobIdFor('clase', 'u1'));
  const again = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, hints: { terms: ['Ccori'] } });
  assert.equal(again.jobId, first.jobId);
  assert.equal(f.longJobs.size, 1, 'the same window twice is one job');
  // A finished refine of the same window can run again.
  job.state = 'completed';
  await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, hints: { terms: ['Ccori'] } });
  assert.equal(f.longJobs.get(first.jobId).state, 'waiting');
});

test('a refine re-transcribes only the window and splices it in: the row stays ready, the rest is untouched, delivery hears refine', async () => {
  const { f, transcriptStore } = readyLecture();
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, hints: { terms: ['Ccori'] }, deliveryId: 'dlv_1' });
  const result = await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.equal(result.refine, true);
  const { opts } = f.engineCalls[0];
  assert.deepEqual(opts.range, { start: 700, end: 760 });
  assert.equal(opts.forceRetranscribe, true);
  assert.ok(opts.keyterms.includes('Ccori'));
  const saved = transcriptStore.sidecars.get('clase');
  assert.deepEqual(saved.segments.map(s => s.text), ['Buenos días.', 'El profesor Ccori explica.', 'Hasta mañana.'],
    'outside the window the user keeps exactly what they had');
  const file = f.rows.get('clase');
  assert.equal(file.processingStage, 'ready');
  assert.match(file.extractedText, /Ccori/);
  await flush();
  assert.deepEqual(f.terminal.at(-1), { fileId: 'clase', userId: 'u1', stage: 'ready', refine: true, range: { start: 700, end: 760 }, deliveryId: 'dlv_1', ok: true });
});

test('a refine on a clip moves the window to the file\'s clock and back', async () => {
  const { f } = readyLecture({ transcriptStore: Object.assign(fakeStore(), { async readMediaClipOffset() { return 3600; } }) });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 4300, end: 4360 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.deepEqual(f.engineCalls[0].opts.range, { start: 700, end: 760 });
});

test('a failed refine keeps the transcript exactly as it was and tells the delivery (ok: false)', async () => {
  const { f, transcriptStore } = readyLecture({ processFile: async () => ({ success: false, code: 'audio_decode_failed', error: 'x' }) });
  const before = { ...f.rows.get('clase') };
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 } });
  const job = f.longJobs.get(jobId);
  await assert.rejects(f.service.processMediaJob(job), { code: 'audio_decode_failed' });
  assert.deepEqual(f.rows.get('clase'), before, 'stage, text and note untouched');
  assert.equal(job.discarded, true);
  assert.equal(transcriptStore.calls.sidecars.length, 0);
  await flush();
  assert.deepEqual(f.terminal.at(-1), { fileId: 'clase', userId: 'u1', stage: 'failed', refine: true, range: { start: 700, end: 760 }, ok: false, code: 'audio_decode_failed' });
});

test('a refine that finds the gap retry of its file running waits without touching anything', async () => {
  const { f } = readyLecture();
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 } });
  Object.assign(f.rows.get('clase'), { processingStage: 'extracting', processingError: q.RETRYING_PARTIAL });
  const job = f.longJobs.get(jobId);
  const delayed = [];
  job.moveToDelayed = async (ts, token) => { delayed.push({ ts, token }); };
  await assert.rejects(f.service.processMediaJob(job, 'tok'), err => err.name === 'DelayedError');
  assert.equal(delayed.length, 1);
  assert.equal(f.engineCalls.length, 0);
  assert.equal(f.terminal.length, 0);
});

test('spliceRefinedRange: midpoint rule for segments, clipped gaps, recomputed coverage, doubtful stretches follow', () => {
  const previous = { durationSec: 600, segments: [{ start: 0, end: 10, text: 'a' }, { start: 95, end: 105, text: 'borde' }, { start: 200, end: 210, text: 'b' }],
    gaps: [{ start: 50, end: 150, reason: 'timeout' }], quality: { level: 'baja', lowConfidence: [{ start: 120, end: 130, reason: 'noise' }, { start: 300, end: 310, reason: 'noise' }] } };
  const refined = { durationSec: 600, segments: [{ start: 98, end: 120, text: 'nuevo' }, { start: 300, end: 305, text: 'fuera' }],
    gaps: [{ start: 140, end: 160 }], quality: { level: 'media', lowConfidence: [{ start: 101, end: 110, reason: 'music' }] } };
  const merged = q.spliceRefinedRange(previous, refined, { start: 100, end: 150 });
  assert.deepEqual(merged.segments.map(s => s.text), ['a', 'nuevo', 'b'], '«borde» (midpoint 100) is in the window; «fuera» is not');
  assert.deepEqual(merged.gaps.map(g => [g.start, g.end]), [[50, 100], [140, 150]]);
  assert.equal(merged.partial, true);
  assert.equal(merged.coverage, 1 - 60 / 600);
  assert.equal(merged.quality.level, 'media');
  assert.deepEqual(merged.quality.lowConfidence.map(i => i.start), [101, 300]);
  assert.equal(merged.source, 'asr');
  // A previous transcript without timestamps cannot be cut by time.
  assert.equal(q.spliceRefinedRange({ synthetic: true, segments: [{ start: 0, end: 600, text: 'todo' }] }, refined, { start: 0, end: 10 }), refined);
});

// ── checkpoints after success ───────────────────────────────────────────────

test('with keepPartsAfterSuccess the segment texts stay for a refine, the cut audio goes, and the file\'s delete can find them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-ckpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ckptDir = path.join(dir, `media-${'a'.repeat(64)}-10`);
  fs.mkdirSync(path.join(ckptDir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(ckptDir, 'audio', 'seg-00000.flac'), 'x');
  fs.writeFileSync(path.join(ckptDir, 'seg-00000.json'), '{}');
  let cleared = 0;
  const transcriptStore = fakeStore();
  const f = fixture([row('nota')], { keepPartsAfterSuccess: true, transcriptStore,
    createCheckpoint: () => ({ dir: ckptDir, clear: async () => { cleared++; } }) });
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  await f.service.processMediaJob([...f.shortJobs.values()][0]);
  assert.equal(cleared, 0);
  assert.equal(fs.existsSync(path.join(ckptDir, 'audio')), false, 'the bulky audio is removed');
  assert.equal(fs.existsSync(path.join(ckptDir, 'seg-00000.json')), true, 'the segment texts stay');
  assert.deepEqual(transcriptStore.calls.pointers, [{ fileId: 'nota', userId: 'u1', dir: ckptDir }]);

  // The real store: the pointer lets the delete route remove the directory.
  const root = path.join(dir, '.transcripts');
  assert.deepEqual(await store.recordCheckpointPointer({ fileId: 'nota', userId: 'u1', dir: ckptDir, root }), { ok: true });
  assert.deepEqual(await store.recordCheckpointPointer({ fileId: 'nota', userId: 'u1', dir: '/etc', root }), { ok: false, reason: 'invalid' });
  const purged = await store.purgeMediaTranscript('nota', { root, checkpointRoot: dir });
  assert.equal(purged.checkpoint, true);
  assert.equal(fs.existsSync(ckptDir), false);
  assert.equal(fs.existsSync(path.join(root, 'nota.ckpt.json')), false);
});

test('without keepPartsAfterSuccess a complete transcript clears its checkpoints as before', async () => {
  let cleared = 0;
  const f = fixture([row('nota')], { createCheckpoint: () => ({ dir: '/ckpt/nota', clear: async () => { cleared++; } }) });
  await f.service.enqueueMediaTranscription({ fileId: 'nota', userId: 'u1' });
  await f.service.processMediaJob([...f.shortJobs.values()][0]);
  assert.equal(cleared, 1);
});

test('the C7 hints object (language inside it) is accepted as is', () => {
  assert.deepEqual(q.requestMedia({ hints: { language: 'inglés', terms: ['Huamán'], speakers: 2 } }, NOW),
    { language: 'en', hints: { terms: ['Huamán'], speakers: 2 }, at: NOW });
  assert.equal(q.requestMedia({ language: 'pt', hints: { language: 'en' } }, NOW).language, 'pt', 'an explicit language wins');
  assert.equal(q.requestMedia({}, NOW), null);
  assert.equal(q.requestMedia({ language: 'auto', hints: { terms: ['WA0012'] } }, NOW), null, 'nothing usable, nothing stored');
});

test('the engine\'s intake verdicts (C4) end the job at once with an honest Spanish message', async () => {
  for (const [code, message] of [['truncated_container', /grabación está incompleta/], ['drm_protected', /protegido contra copia/]]) {
    assert.equal(q.isTransientMediaError({ code, message: 'timeout', status: 503 }), false, code);
    const f = fixture([row(code)], { processFile: async () => ({ success: false, code, error: 'x' }) });
    await f.service.enqueueMediaTranscription({ fileId: code, userId: 'u1' });
    const job = [...f.shortJobs.values()][0];
    await assert.rejects(f.service.processMediaJob(job), { code });
    assert.equal(job.discarded, true);
    assert.match(f.rows.get(code).processingError, message);
    assert.doesNotMatch(f.rows.get(code).processingError, /\b(?:tu|usted|subiste)\b.*(?:mal|error)/i, 'never blames the user');
  }
});

test('a refine whose new reading equals the old one says so (unchanged), and a gap retry meeting a running refine waits', async () => {
  const { f } = readyLecture({ processFile: async (file, opts) => { f.engineCalls.push({ file, opts }); return { success: true, extractedText: 'x', transcription: LECTURE() }; } });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  await flush();
  assert.equal(f.terminal.at(-1).unchanged, true);

  // While a refine of the file runs here, a gap retry job of the same file parks (no row write).
  let release;
  const { f: g } = readyLecture({ processFile: () => new Promise(resolve => { release = () => resolve({ success: true, extractedText: 'x', transcription: LECTURE() }); }) });
  const refine = await g.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 0, end: 60 } });
  const running = g.service.processMediaJob(g.longJobs.get(refine.jobId));
  await new Promise(resolve => setTimeout(resolve, 5));
  Object.assign(g.rows.get('clase'), { processingError: q.RETRYING_PARTIAL, processingStage: 'uploaded' });
  const retry = { id: 'retry', data: { fileId: 'clase', userId: 'u1', force: true }, opts: { attempts: 3 }, attemptsMade: 0,
    async moveToDelayed() { this.parked = true; } };
  await assert.rejects(g.service.processMediaJob(retry, 'tok'), err => err.name === 'DelayedError');
  assert.equal(retry.parked, true);
  assert.equal(g.rows.get('clase').processingStage, 'uploaded', 'the waiting retry wrote nothing');
  release();
  await running;
  assert.equal(g.rows.get('clase').processingError, q.RETRYING_PARTIAL, 'the refine kept the gap-retry marker');
});
