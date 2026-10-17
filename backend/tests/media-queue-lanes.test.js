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
  assert.equal(opts.refineSkipUnusable, true, 'a transcript it can cut into: the engine reads only the window');
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

test('spliceRefinedRange: cut where no segment crosses, clipped gaps, recomputed coverage, doubtful stretches follow', () => {
  const previous = { durationSec: 600, segments: [{ start: 0, end: 10, text: 'a' }, { start: 95, end: 105, text: 'borde' }, { start: 200, end: 210, text: 'b' }],
    gaps: [{ start: 50, end: 150, reason: 'timeout' }], quality: { level: 'baja', lowConfidence: [{ start: 120, end: 130, reason: 'noise' }, { start: 300, end: 310, reason: 'noise' }] } };
  const refined = { durationSec: 600, segments: [{ start: 98, end: 120, text: 'nuevo' }, { start: 300, end: 305, text: 'fuera' }],
    gaps: [{ start: 140, end: 160 }], quality: { level: 'media', lowConfidence: [{ start: 101, end: 110, reason: 'music' }] } };
  const merged = q.spliceRefinedRange(previous, refined, { start: 100, end: 150 });
  assert.deepEqual(merged.segments.map(s => s.text), ['a', 'nuevo', 'b'], '«borde» straddles the edge and the refined result read it: the cut moves to 95; «fuera» is not in the window');
  assert.deepEqual(q.refineSpliceWindow(previous, refined, { start: 100, end: 150 }), { start: 95, end: 150 });
  assert.deepEqual(merged.gaps.map(g => [g.start, g.end]), [[50, 95], [140, 150]]);
  assert.equal(merged.partial, true);
  assert.equal(merged.coverage, 1 - 55 / 600);
  assert.equal(merged.quality.level, 'media');
  assert.deepEqual(merged.quality.lowConfidence.map(i => i.start), [101, 300]);
  assert.equal(merged.source, 'asr');
  // A previous transcript without timestamps cannot be cut by time.
  assert.equal(q.spliceRefinedRange({ synthetic: true, segments: [{ start: 0, end: 600, text: 'todo' }] }, refined, { start: 0, end: 10 }), refined);
});

// Misaligned boundaries: the refined pieces are re-read with another
// hypothesis, so their segments rarely end where the stored ones did, and the
// user's minutes fall inside speech.
const MISALIGNED_PREVIOUS = () => ({ ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [
    { start: 600, end: 700, text: 'antes' },
    { start: 700, end: 712, text: 'uno dos tres' },
    { start: 712, end: 730, text: 'cuatro cinco seis siete' },
    { start: 730, end: 890, text: 'medio' },
    { start: 890, end: 899, text: 'ocho nueve diez' },
    { start: 899, end: 905, text: 'once' },
    { start: 905, end: 1000, text: 'después' },
  ] });
const MISALIGNED_REFINED = () => ({ ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [
    { start: 700, end: 719, text: 'uno dos tres cuatro cinco' },
    { start: 719, end: 730, text: 'seis siete' },
    { start: 730, end: 890, text: 'medio corregido' },
    { start: 890, end: 897, text: 'ocho nueve' },
    { start: 897, end: 905, text: 'diez once' },
  ] });
const wordsOf = result => result.segments.map(seg => seg.text).join(' ').split(/\s+/).filter(Boolean);

test('spliceRefinedRange: misaligned boundaries at both edges lose no word and repeat none', () => {
  const merged = q.spliceRefinedRange(MISALIGNED_PREVIOUS(), MISALIGNED_REFINED(), { start: 720, end: 900 });
  assert.deepEqual(wordsOf(merged), ['antes', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'medio', 'corregido',
    'ocho', 'nueve', 'diez', 'once', 'después'], '«cuatro cinco» and «diez» stay, each once');
  assert.deepEqual(q.refineSpliceWindow(MISALIGNED_PREVIOUS(), MISALIGNED_REFINED(), { start: 720, end: 900 }), { start: 700, end: 905 });
  // The boundaries the other way round (the stored segments are the long ones).
  const swapped = q.spliceRefinedRange(MISALIGNED_REFINED(), MISALIGNED_PREVIOUS(), { start: 720, end: 900 });
  assert.deepEqual(wordsOf(swapped), ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'medio',
    'ocho', 'nueve', 'diez', 'once'], 'no repeated «cuatro cinco» nor «diez»');
  assert.equal(merged.partial, false);
  assert.deepEqual(merged.gaps, []);
});

test('spliceRefinedRange: a refined result that covers only the window never costs the text beyond it (engine contract)', () => {
  const previous = MISALIGNED_PREVIOUS();
  previous.segments.splice(1, 3, { start: 650, end: 725, text: 'largo sin releer' }, { start: 725, end: 890, text: 'medio' });
  // Only the window was re-read (the engine says which stretch); the pieces around it were skipped.
  const refined = { ok: true, durationSec: 1800, refineSkipped: 2, refineSpans: [[700, 905]], gaps: [], coverage: 1,
    segments: [{ start: 725, end: 890, text: 'medio corregido' }, { start: 890, end: 905, text: 'ocho nueve diez once' }] };
  const merged = q.spliceRefinedRange(previous, refined, { start: 720, end: 900 });
  assert.deepEqual(merged.segments.map(seg => seg.text), ['antes', 'largo sin releer', 'medio corregido', 'ocho nueve diez once', 'después'],
    'the stored segment the refine never touched is kept whole');
  assert.equal(merged.partial, false, 'what the refine skipped is never a gap');
  assert.equal(merged.coverage, 1);
  assert.equal(q.refineLosesText(previous, refined, { start: 720, end: 900 }), false);
  assert.equal('refineSpans' in merged || 'refineSkipped' in merged, false, 'refine-only fields never reach the stored transcript');
  // Skipped pieces without the spans the engine read again: nothing can be cut in safely.
  const { refineSpans: _spans, ...unknown } = refined;
  assert.equal(q.refineLosesText(previous, unknown, { start: 720, end: 900 }), true);
  assert.equal(q.spliceRefinedRange(previous, unknown, { start: 720, end: 900 }), previous);
});

// The pieces next to the window were skipped (no checkpoint), and a segment
// end runs a little past its piece's cut: at the start edge the stored last
// segment of the skipped piece (0.4 s), at the end edge the refined last
// segment of the re-read piece (1.2 s). That overrun re-reads nothing.
const OVERRUN_PREVIOUS = () => ({ ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [
    { start: 560, end: 585, text: 'alfa beta' },
    { start: 585, end: 596.4, text: 'gamma delta' },
    { start: 596, end: 700, text: 'épsilon viejo' },
    { start: 700, end: 880, text: 'zeta viejo' },
    { start: 880, end: 895, text: 'eta viejo' },
    { start: 895, end: 925, text: 'theta iota' },
    { start: 925, end: 1000, text: 'kappa' },
  ] });
const OVERRUN_REFINED = () => ({ ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1, refineSkipped: 2,
  refineSpans: [[596, 895]],
  segments: [
    { start: 596, end: 700, text: 'épsilon nuevo' },
    { start: 700, end: 870, text: 'zeta nuevo' },
    { start: 870, end: 896.2, text: 'eta nuevo' },
  ] });
const OVERRUN_WORDS = ['alfa', 'beta', 'gamma', 'delta', 'épsilon', 'nuevo', 'zeta', 'nuevo', 'eta', 'nuevo', 'theta', 'iota', 'kappa'];

test('spliceRefinedRange: a segment overrunning a cut into a skipped piece never costs that piece its text', () => {
  const range = { start: 600, end: 890 };
  assert.deepEqual(q.refineSpliceWindow(OVERRUN_PREVIOUS(), OVERRUN_REFINED(), range), { start: 596, end: 896.2 });
  const merged = q.spliceRefinedRange(OVERRUN_PREVIOUS(), OVERRUN_REFINED(), range);
  assert.deepEqual(wordsOf(merged), OVERRUN_WORDS, '«gamma delta» and «theta iota» stay, each once; nothing old in the window');
  assert.equal(merged.partial, false);
  assert.equal(q.refineLosesText(OVERRUN_PREVIOUS(), OVERRUN_REFINED(), range), false);
  // A real re-reading of a stored segment straddling a cut still moves it.
  const reread = { ...OVERRUN_REFINED(), refineSpans: [[585, 895]] };
  reread.segments.unshift({ start: 585.2, end: 596, text: 'gamma delta' });
  assert.equal(q.refineSpliceWindow(OVERRUN_PREVIOUS(), reread, range).start, 585);
  assert.deepEqual(wordsOf(q.spliceRefinedRange(OVERRUN_PREVIOUS(), reread, range)), OVERRUN_WORDS);
});

// Nothing skipped (the default: every piece outside the window is reused from
// its checkpoint). The two readings time the silence around the words
// differently: the stored segment at each edge runs into the silence, the
// refined one stops at the last word, so the refined text covers less than
// 2 s of it. It is the same speech all the same: the cut must take it in.
const SILENCE_PREVIOUS = () => ({ ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [
    { start: 500, end: 695.5, text: 'antes' },
    { start: 696, end: 700.42, text: 'uno dos tres cuatro' },
    { start: 700.42, end: 880, text: 'cinco medio' },
    { start: 880, end: 951.58, text: 'ocho nueve' },
    { start: 951.58, end: 956, text: 'diez once doce trece' },
    { start: 956.5, end: 1000, text: 'después' },
  ] });
const SILENCE_REFINED = (texts = ['antes', 'uno dos tres cuatro cinco', 'medio corregido', 'ocho', 'nueve diez once doce trece', 'después']) => ({
  ok: true, durationSec: 1800, language: 'es', engine: 'local', partial: false, gaps: [], coverage: 1,
  segments: [[500, 695], [698.55, 701.03], [701.03, 880], [880, 950.97], [950.97, 953.45], [956.5, 1000]]
    .map(([start, end], i) => ({ start, end, text: texts[i] })) });

test('spliceRefinedRange: with nothing skipped, a stored segment the refine re-read with other silences never repeats its words', () => {
  const range = { start: 700, end: 952 };
  assert.deepEqual(q.refineSpliceWindow(SILENCE_PREVIOUS(), SILENCE_REFINED(), range), { start: 696, end: 956 });
  const merged = q.spliceRefinedRange(SILENCE_PREVIOUS(), SILENCE_REFINED(), range);
  assert.deepEqual(wordsOf(merged), ['antes', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'medio', 'corregido', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'después'], '«uno dos tres cuatro» and «diez once doce trece» appear once');
  assert.equal(merged.partial, false);
  assert.equal(q.refineLosesText(SILENCE_PREVIOUS(), SILENCE_REFINED(), range), false);
});

test('spliceRefinedRange: the window\'s language never becomes the file\'s', () => {
  const previous = { ...LECTURE(), hints: { terms: ['Ccori'] } };
  const refined = { ...LECTURE(), language: 'en', hints: { language: 'en', terms: ['Ccori', 'Pérez'] } };
  const merged = q.spliceRefinedRange(previous, refined, { start: 700, end: 760 });
  assert.equal(merged.language, 'es', '«está en inglés» was about minutes 12 to 13 only');
  assert.deepEqual(merged.hints, { terms: ['Ccori', 'Pérez'] }, 'the names count for the whole file, the language does not');
  // A file-level language the user gave before stays.
  const told = q.spliceRefinedRange({ ...previous, hints: { language: 'es', terms: ['Ccori'] } }, refined, { start: 700, end: 760 });
  assert.deepEqual(told.hints, { terms: ['Ccori', 'Pérez'], language: 'es' });
  // A refine without hints keeps the stored ones.
  const plain = q.spliceRefinedRange({ ...previous, hints: { language: 'es', terms: ['Ccori'] } }, { ...LECTURE(), language: 'en' }, { start: 700, end: 760 });
  assert.deepEqual(plain.hints, { language: 'es', terms: ['Ccori'] });
  assert.equal(plain.language, 'es');
});

function refineOver(previousResult, refinedResult) {
  const transcriptStore = fakeStore({ durations: new Map([['clase', 1800]]) });
  if (previousResult) transcriptStore.sidecars.set('clase', store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: previousResult })));
  const f = fixture([row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 400_000_000, processingStage: 'ready',
    extractedText: '[10:00] antes. [11:40] uno dos tres.' })], {
    transcriptStore,
    processFile: async (file, opts) => { f.engineCalls.push({ file, opts }); return { success: true, extractedText: 'x', transcription: refinedResult() }; },
  });
  return { f, transcriptStore };
}

test('a refine that reads the same words with other segment boundaries reports «unchanged» and stores each word once', async () => {
  const sameWords = () => {
    const result = MISALIGNED_PREVIOUS();
    result.segments.splice(1, 2, { start: 700, end: 719, text: 'uno dos tres cuatro cinco' }, { start: 719, end: 730, text: 'seis siete' });
    return result;
  };
  const { f, transcriptStore } = refineOver(MISALIGNED_PREVIOUS(), sameWords);
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 720, end: 900 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  await flush();
  assert.equal(f.terminal.at(-1).ok, true);
  assert.equal(f.terminal.at(-1).unchanged, true, 'the window is compared at the cut points, not by midpoints');
  assert.deepEqual(wordsOf(transcriptStore.sidecars.get('clase')), wordsOf(MISALIGNED_PREVIOUS()));
});

test('a refine next to skipped pieces keeps their text when a segment overruns the cut (end to end)', async () => {
  const { f, transcriptStore } = refineOver(OVERRUN_PREVIOUS(), OVERRUN_REFINED);
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 600, end: 890 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  await flush();
  assert.equal(f.terminal.at(-1).ok, true);
  assert.equal(f.terminal.at(-1).unchanged, undefined);
  assert.deepEqual(wordsOf(transcriptStore.sidecars.get('clase')), OVERRUN_WORDS);
  assert.match(f.rows.get('clase').extractedText, /gamma delta/);
  assert.match(f.rows.get('clase').extractedText, /theta iota/);
});

test('a refine that reads the same words with the silences timed otherwise reports «unchanged» and stores each word once', async () => {
  const sameWords = () => SILENCE_REFINED(SILENCE_PREVIOUS().segments.map(seg => seg.text));
  const { f, transcriptStore } = refineOver(SILENCE_PREVIOUS(), sameWords);
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 952 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  await flush();
  assert.equal(f.terminal.at(-1).ok, true);
  assert.equal(f.terminal.at(-1).unchanged, true);
  assert.deepEqual(wordsOf(transcriptStore.sidecars.get('clase')), wordsOf(SILENCE_PREVIOUS()));
});

test('a refine whose window comes back as a gap fails (refine_incomplete) and leaves the transcript exactly as it was', async () => {
  const gapped = () => {
    const result = LECTURE();
    result.segments.splice(1, 1);
    return { ...result, gaps: [{ start: 700, end: 760, reason: 'all_rungs_failed' }], partial: true, coverage: 0.97 };
  };
  const { f, transcriptStore } = readyLecture({ processFile: async () => ({ success: true, extractedText: 'x', transcription: gapped() }) });
  const before = { ...f.rows.get('clase') };
  const sidecarBefore = transcriptStore.sidecars.get('clase');
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, deliveryId: 'dlv_9' });
  const job = f.longJobs.get(jobId);
  await assert.rejects(f.service.processMediaJob(job), { code: 'refine_incomplete' });
  assert.deepEqual(f.rows.get('clase'), before, 'text, stage and note untouched: never «Parcial»');
  assert.equal(transcriptStore.sidecars.get('clase'), sidecarBefore);
  assert.equal(transcriptStore.calls.sidecars.length, 0);
  assert.equal(transcriptStore.calls.analyses.length, 0);
  assert.equal(job.discarded, true, 'not retried in a loop');
  assert.equal(q.isTransientMediaError({ code: 'refine_incomplete' }), false);
  await flush();
  assert.deepEqual(f.terminal.at(-1), { fileId: 'clase', userId: 'u1', stage: 'failed', refine: true, range: { start: 700, end: 760 },
    deliveryId: 'dlv_9', ok: false, code: 'refine_incomplete' });
});

test('a refine of a window that already had a gap may keep part of it: the rest is recovered', async () => {
  const previousWithGap = () => ({ ...LECTURE(), segments: LECTURE().segments.filter(seg => seg.start !== 720),
    gaps: [{ start: 700, end: 760, reason: 'timeout' }], partial: true, coverage: 0.97 });
  const half = () => ({ ...LECTURE(), segments: [...LECTURE().segments.filter(seg => seg.start !== 720), { start: 735, end: 755, text: 'Recuperado.' }],
    gaps: [{ start: 700, end: 730, reason: 'timeout' }], partial: true });
  const { f, transcriptStore } = refineOver(previousWithGap(), half);
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  const saved = transcriptStore.sidecars.get('clase');
  assert.ok(saved.segments.some(seg => seg.text === 'Recuperado.'));
  assert.deepEqual(saved.gaps.map(g => [g.start, g.end]), [[700, 730]]);
  await flush();
  assert.equal(f.terminal.at(-1).ok, true);
});

test('a stored transcript without segments is never replaced by a refined result that skipped pieces', async () => {
  const windowOnly = () => ({ ok: true, durationSec: 1800, refineSkipped: 4, gaps: [], segments: [{ start: 700, end: 760, text: 'Solo el tramo.' }] });
  const { f, transcriptStore } = refineOver(null, windowOnly);
  const before = { ...f.rows.get('clase') };
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 } });
  await assert.rejects(f.service.processMediaJob(f.longJobs.get(jobId)), { code: 'refine_incomplete' });
  assert.deepEqual(f.rows.get('clase'), before);
  assert.equal(transcriptStore.calls.sidecars.length, 0);
});

// Pieces skipped far from the window (no part kept there) must not change
// how the window's edges are cut: the engine names the stretches it read
// again (`refineSpans`), and a segment belongs to the piece it starts in.
test('spliceRefinedRange: with a piece skipped elsewhere, silences timed otherwise at both edges still keep each word once', () => {
  const previous = { ...SILENCE_PREVIOUS(), segments: [...SILENCE_PREVIOUS().segments, { start: 1500, end: 1600, text: 'pieza lejana' }] };
  const refined = { ...SILENCE_REFINED(), refineSkipped: 1, refineSpans: [[600, 800], [800, 1000]] };
  const range = { start: 700, end: 952 };
  assert.deepEqual(q.refineSpliceWindow(previous, refined, range), { start: 696, end: 956 });
  assert.equal(q.refineLosesText(previous, refined, range), false);
  const merged = q.spliceRefinedRange(previous, refined, range);
  assert.deepEqual(wordsOf(merged), ['antes', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'medio', 'corregido', 'ocho', 'nueve',
    'diez', 'once', 'doce', 'trece', 'después', 'pieza', 'lejana'], 'a piece skipped 500 s away never repeats a word at the edges');
});

// Deterministic fuzz: pieces cut at silences, two readings with their own
// segment boundaries and silence timing, segment ends overrunning a cut, the
// user's minutes falling inside speech, and pieces outside the window
// skipped (some of them stored gaps of a partial transcript) or reused.
function fuzzRandom(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzRefineCase(rnd, { overrun, tiled }) {
  const pieces = [];
  let clock = 0;
  for (let i = 0; i < 8; i++) { const len = 60 + Math.floor(rnd() * 240); pieces.push({ start: clock, end: clock + len }); clock += len; }
  let id = 0;
  const words = pieces.map(piece => {
    const list = [];
    let x = piece.start + 0.3 + rnd();
    while (x < piece.end - 0.5) { list.push({ t: x, w: `w${id++}` }); x += 0.25 + rnd() * 0.5; if (rnd() < 0.03) x += 2 + rnd() * 4; }
    return list;
  });
  const reading = (piece, list) => {
    const groups = [];
    let current = [];
    for (const word of list) { current.push(word); if (current.length >= 3 + Math.floor(rnd() * 25)) { groups.push(current); current = []; } }
    if (current.length) groups.push(current);
    const segments = groups.map((group, i) => {
      let end = group[group.length - 1].t + 0.2 + rnd() * 0.3;
      if (i === groups.length - 1 && rnd() < 0.5) end = piece.end + overrun * rnd();
      return { start: Math.max(piece.start, group[0].t - rnd() * 0.2), end, text: group.map(word => word.w).join(' ') };
    });
    if (tiled) {
      for (let i = 0; i + 1 < segments.length; i++) segments[i].end = segments[i + 1].start;
      if (segments.length) segments[0].start = piece.start;
    }
    return segments;
  };
  const a = rnd() * clock * 0.9;
  const b = Math.min(clock, a + 10 + rnd() * 400);
  const range = { start: a, end: b };
  const previousSegments = [];
  const previousGaps = [];
  const refinedSegments = [];
  const refineSpans = [];
  let refineSkipped = 0;
  const expected = [];
  pieces.forEach((piece, i) => {
    const inWindow = piece.start < b && piece.end > a;
    const fate = inWindow ? 'reread' : (rnd() < 0.7 ? 'skipped' : 'reused');
    if (!inWindow && fate === 'skipped' && rnd() < 0.25) {
      previousGaps.push({ start: piece.start, end: piece.end, reason: 'timeout' });
    } else {
      previousSegments.push(...reading(piece, words[i]));
      expected.push(...words[i].map(word => word.w));
    }
    if (fate === 'reread') { refinedSegments.push(...reading(piece, words[i])); refineSpans.push([piece.start, piece.end]); }
    else if (fate === 'reused') refinedSegments.push(...reading(piece, words[i]));
    else refineSkipped++;
  });
  if (!refineSkipped) return null;
  const previous = { ok: true, durationSec: clock, gaps: previousGaps, coverage: 1, partial: previousGaps.length > 0, source: 'asr', segments: previousSegments };
  const refined = { ok: true, durationSec: clock, gaps: [], coverage: 1, partial: false, segments: refinedSegments, refineSkipped, refineSpans };
  return { previous, refined, range, expected };
}

test('spliceRefinedRange (fuzz): misaligned boundaries at both edges with pieces skipped elsewhere lose and repeat no word', () => {
  let cases = 0;
  for (const overrun of [0.5, 2]) {
    for (const tiled of [false, true]) {
      const rnd = fuzzRandom(1000 + overrun * 10 + (tiled ? 1 : 0));
      for (let k = 0; k < 150; k++) {
        const scenario = fuzzRefineCase(rnd, { overrun, tiled });
        if (!scenario) continue;
        cases++;
        const { previous, refined, range, expected } = scenario;
        const label = `overrun ${overrun}, ${tiled ? 'tiled' : 'pauses'}, case ${k}`;
        assert.equal(q.refineLosesText(previous, refined, range), false, label);
        const merged = q.spliceRefinedRange(previous, refined, range);
        const counts = new Map();
        for (const word of wordsOf(merged)) counts.set(word, (counts.get(word) || 0) + 1);
        const lost = expected.filter(word => !counts.has(word));
        const repeated = [...counts].filter(([, n]) => n > 1).map(([word]) => word);
        assert.deepEqual({ lost, repeated }, { lost: [], repeated: [] }, label);
        assert.equal(counts.size, expected.length, label);
        // A stored gap in a piece the refine skipped stays exactly as it was.
        assert.deepEqual(merged.gaps.map(g => [g.start, g.end]), previous.gaps.map(g => [g.start, g.end]), label);
      }
    }
  }
  assert.ok(cases > 400, `enough skipped-piece refines (${cases})`);
});

test('a refine on a clip: the stretches the engine read again move to the recording\'s clock with the segments', async () => {
  const onClip = result => ({ ...result, timeOffsetSec: 3600, segments: result.segments.map(seg => ({ ...seg, start: seg.start + 3600, end: seg.end + 3600 })) });
  const transcriptStore = Object.assign(fakeStore({ durations: new Map([['clase', 1800]]) }), { async readMediaClipOffset() { return 3600; } });
  transcriptStore.sidecars.set('clase', store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: onClip(LECTURE()) })));
  const f = fixture([row('clase', { originalName: 'clase.mp3', mimeType: 'audio/mpeg', size: 400_000_000, processingStage: 'ready',
    extractedText: '[01:00:00] Buenos días. [01:12:00] El profesor Kori explica.' })], {
    transcriptStore,
    // The engine works on the file's clock: only the piece at 600–1200 s was read again.
    processFile: async (file, opts) => {
      f.engineCalls.push({ file, opts });
      return { success: true, extractedText: 'x', transcription: { ok: true, durationSec: 1800, refineSkipped: 2, refineSpans: [[600, 1200]], gaps: [],
        segments: [{ start: 720, end: 730, text: 'El profesor Ccori explica.' }], transcript: 'El profesor Ccori explica.' } };
    },
  });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 4300, end: 4360 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.deepEqual(f.engineCalls[0].opts.range, { start: 700, end: 760 });
  assert.deepEqual(transcriptStore.sidecars.get('clase').segments.map(seg => [seg.start, seg.text]),
    [[3600, 'Buenos días.'], [4320, 'El profesor Ccori explica.'], [5100, 'Hasta mañana.']]);
});

test('a refine of a silent window never runs the whole-file fallbacks: «no speech» fails it and the transcript stays as it was', async () => {
  const outcomes = {
    // The engine read only the window and heard nothing there.
    engine_no_speech: async () => ({ success: false, code: 'no_speech', error: 'No se detectó voz en el archivo.' }),
    // The window came back as invented text only (removed by the cleanup).
    invented_only: async () => ({ success: true, extractedText: 'x', transcription: { ok: true, durationSec: 1800, refineSkipped: 2,
      refineSpans: [[600, 1200]], gaps: [], segments: [{ start: 720, end: 726, text: 'Subtítulos realizados por la comunidad de Amara.org' }] } }),
  };
  for (const [name, engine] of Object.entries(outcomes)) {
    const calls = { subtitles: 0, screen: 0, captions: 0 };
    const transcriptStore = fakeStore({ durations: new Map([['clase', 1800]]) });
    transcriptStore.sidecars.set('clase', store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: LECTURE() })));
    const f = fixture([row('clase', { originalName: 'clase.mp4', mimeType: 'video/mp4', size: 400_000_000, processingStage: 'ready',
      extractedText: '[00:00] Buenos días. [12:00] El profesor Kori explica.' })], {
      transcriptStore,
      processFile: async (file, opts) => { f.engineCalls.push({ file, opts }); return engine(); },
      mediaTools: {
        probe: async () => ({ ok: true, hasAudio: true, hasVideo: true, hasTextSubtitles: true, durationSec: 1800,
          subtitles: [{ textBased: true, streamOrdinal: 0, language: 'es', codec: 'subrip' }] }),
        extractSubtitles: async () => { calls.subtitles++; return { ok: true, codec: 'subrip', segments: [{ start: 0, end: 1800, text: 'Subtítulo de todo el video.' }] }; },
        extractOnScreenText: async () => { calls.screen++; return { ok: true, items: [{ start: 0, end: 1800, text: 'Texto en pantalla de todo el video' }] }; },
      },
      readLinkCaptions: async () => { calls.captions++; return { segments: [{ start: 0, end: 1800, text: 'Subtítulos del enlace.' }] }; },
    });
    const before = { ...f.rows.get('clase') };
    const sidecarBefore = transcriptStore.sidecars.get('clase');
    const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 720, end: 900 }, deliveryId: 'dlv_s' });
    const job = f.longJobs.get(jobId);
    await assert.rejects(f.service.processMediaJob(job), { code: 'no_speech' }, name);
    assert.deepEqual(calls, { subtitles: 0, screen: 0, captions: 0 }, `${name}: no subtitle track, OCR pass or link captions for a window`);
    assert.deepEqual(f.rows.get('clase'), before, `${name}: text, stage and note untouched`);
    assert.equal(transcriptStore.sidecars.get('clase'), sidecarBefore, name);
    assert.equal(transcriptStore.calls.sidecars.length, 0, name);
    assert.equal(transcriptStore.calls.analyses.length, 0, name);
    assert.equal(job.discarded, true, `${name}: the window's verdict is final`);
    await flush();
    assert.deepEqual(f.terminal.at(-1), { fileId: 'clase', userId: 'u1', stage: 'failed', refine: true, range: { start: 720, end: 900 },
      deliveryId: 'dlv_s', ok: false, code: 'no_speech' }, name);
  }
});

test('a refine of a transcript the queue cannot cut into asks the engine for every piece and replaces it whole', async () => {
  // A fake engine with the engine's contract: without parts kept it skips the
  // pieces outside the window unless told it may not (refineSkipUnusable: false).
  const engine = opts => {
    if (opts.refineSkipUnusable === false) {
      const whole = LECTURE();
      whole.segments[1].text = 'El profesor Ccori explica.';
      return { ...whole, transcript: whole.segments.map(seg => seg.text).join(' '), refineSpans: [[600, 1200]] };
    }
    return { ok: true, durationSec: 1800, refineSkipped: 2, refineSpans: [[600, 1200]], gaps: [],
      segments: [{ start: 720, end: 730, text: 'El profesor Ccori explica.' }] };
  };
  const stored = {
    no_sidecar: null,
    from_the_screen: { ...LECTURE(), source: 'onscreen' },
  };
  for (const [name, previous] of Object.entries(stored)) {
    const { f, transcriptStore } = refineOver(previous, () => null);
    f.engineCalls.length = 0;
    const service = q.createMediaTranscriptionService({
      prisma: f.prisma, getQueue: () => f.longQueue, getShortQueue: () => f.shortQueue, now: () => NOW,
      validate: async (_local, file) => file.mimeType, offload: async file => file.path,
      materialize: async source => ({ path: source, cleanup: async () => {} }),
      createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => {} }),
      processFile: async (file, opts) => { f.engineCalls.push({ file, opts }); return { success: true, extractedText: 'x', transcription: engine(opts) }; },
      transcriptStore, onTerminal: payload => f.terminal.push(payload), logger: { warn() {}, info() {} },
    });
    const { jobId } = await service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 720, end: 760 } });
    await service.processMediaJob(f.longJobs.get(jobId));
    assert.equal(f.engineCalls[0].opts.refineSkipUnusable, false, `${name}: the engine reads the pieces it cannot reuse`);
    const saved = transcriptStore.sidecars.get('clase');
    assert.deepEqual(saved.segments.map(seg => seg.text), ['Buenos días.', 'El profesor Ccori explica.', 'Hasta mañana.'], `${name}: replaced whole`);
    assert.equal('refineSpans' in transcriptStore.calls.sidecars[0], false, `${name}: refine-only fields are not stored`);
    assert.match(f.rows.get('clase').extractedText, /Ccori/);
    await flush();
    assert.equal(f.terminal.at(-1).ok, true, `${name}: never refine_incomplete`);
  }
});

test('a refine whose window is the whole recording takes its language for the file (sidecar and analysis)', async () => {
  const previous = { ...LECTURE(), hints: { terms: ['Ccori'] } };
  const refined = { ...LECTURE(), language: 'en', hints: { language: 'en', terms: ['Ccori'] } };
  const merged = q.spliceRefinedRange(previous, refined, { start: 0, end: 1800 });
  assert.equal(merged.language, 'en', 'none of the old text is left');
  assert.deepEqual(merged.hints, { terms: ['Ccori'], language: 'en' });
  // A clip: the recording's clock starts at its offset.
  const shift = result => ({ ...result, timeOffsetSec: 3600, segments: result.segments.map(seg => ({ ...seg, start: seg.start + 3600, end: seg.end + 3600 })) });
  assert.equal(q.spliceRefinedRange(shift(previous), shift(refined), { start: 3600, end: 5400 }).language, 'en');
  assert.equal(q.spliceRefinedRange(shift(previous), shift(refined), { start: 3600, end: 5000 }).language, 'es', 'part of it: the file keeps its own');

  // End to end: the stored transcript and its analysis say English.
  const { f, transcriptStore } = refineOver(LECTURE(), () => ({ ...LECTURE(), language: 'en' }));
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 0, end: 1800 }, language: 'en' });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.equal(transcriptStore.sidecars.get('clase').language, 'en');
  assert.equal(transcriptStore.calls.analyses.at(-1).result.language, 'en');
});

test('a refine\'s language stays in its job: the file keeps only the names, and a later retry is not forced into it', async () => {
  const { f, transcriptStore } = readyLecture();
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 720, end: 900 },
    language: 'en', hints: { terms: ['Ccori'] } });
  assert.deepEqual(transcriptStore.calls.hintWrites.map(w => [w.language, w.hints]), [[null, { terms: ['Ccori'] }]]);
  assert.equal(transcriptStore.hints.get('clase').language, undefined, 'no file-level language');
  assert.deepEqual(transcriptStore.hints.get('clase').terms, ['Ccori']);
  const job = f.longJobs.get(jobId);
  assert.equal(job.data.language, 'en', 'the refine itself still runs in English');
  await f.service.processMediaJob(job);
  assert.equal(f.engineCalls[0].opts.language, 'en');
  assert.deepEqual(transcriptStore.sidecars.get('clase').hints, { terms: ['Ccori'] }, 'the stored transcript never says «idioma inglés»');
  // A refine with only a language writes nothing durable.
  await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 0, end: 60 }, language: 'en' });
  assert.equal(transcriptStore.calls.hintWrites.length, 1);
  // A gap retry re-queued with only { fileId, userId } runs without that language.
  Object.assign(f.rows.get('clase'), { processingStage: 'uploaded', processingError: q.RETRYING_PARTIAL });
  await f.service.processMediaJob({ id: 'retry', data: { fileId: 'clase', userId: 'u1', force: true }, opts: { attempts: 3 }, attemptsMade: 0 });
  assert.equal(f.engineCalls.at(-1).opts.language, undefined, 'never forced to English');
  assert.ok(f.engineCalls.at(-1).opts.keyterms.includes('Ccori'), 'the names still help');
});

test('a refine keeps its own language when the file\'s durable hints change while it waits', async () => {
  const { f, transcriptStore } = readyLecture();
  // The first request said the class is in Spanish.
  transcriptStore.hints.set('clase', { language: 'es', updatedAt: new Date(NOW - 3600_000).toISOString() });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 720, end: 900 },
    language: 'en', hints: { terms: ['Ccori'] } });
  // While the refine waits behind long jobs, another turn names a speaker.
  await transcriptStore.recordMediaHints(null, { fileId: 'clase', userId: 'u1', language: null, hints: { terms: ['Pérez'] }, at: NOW + 60_000 });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.equal(f.engineCalls[0].opts.language, 'en', 'the window is still read in English, never forced to Spanish');
  assert.ok(f.engineCalls[0].opts.keyterms.includes('Pérez'), 'the newer names still reach it');
  assert.ok(f.engineCalls[0].opts.keyterms.includes('Ccori'));
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

// ── refine: file-level summary, silent windows, other cut plans ─────────────

test('spliceRefinedRange: a result that skipped pieces never replaces the file-level quality, providers and engine', () => {
  const previous = { ...LECTURE(), engine: 'cloud', providers: { groq: 2 }, partial: true, coverage: 0.667,
    gaps: [{ start: 1200, end: 1800, reason: 'provider_error' }],
    quality: { score: 0.667, level: 'media', escalations: 1, enginesUsed: ['groq:whisper-large-v3-turbo'], notes: ['Revisé 1 tramo dudoso con otro motor o con el audio realzado.'],
      lowConfidence: [{ start: 5, end: 8, reason: 'low_confidence' }, { start: 722, end: 725, reason: 'low_confidence' }] } };
  previous.segments = previous.segments.filter(seg => seg.start < 1200);
  // The refine read only the piece at 600–1200 s, with the local engine, and liked it.
  const refined = { ok: true, durationSec: 1800, engine: 'local', method: 'local-whisper', providers: { local: 1 }, refineSkipped: 2, refineSpans: [[600, 1200]],
    gaps: [], coverage: 1, partial: false, segments: [{ start: 720, end: 730, text: 'El profesor Ccori explica.' }],
    quality: { score: 1, level: 'alta', escalations: 0, enginesUsed: ['local:ggml-base.bin'], notes: [], lowConfidence: [] } };
  const merged = q.spliceRefinedRange(previous, refined, { start: 700, end: 760 });
  assert.equal(merged.quality.level, 'media', 'a 600 s gap is still in the file: never «alta»');
  assert.equal(merged.quality.score, 0.667);
  assert.deepEqual(merged.quality.notes, previous.quality.notes);
  assert.equal(merged.quality.escalations, 1);
  assert.deepEqual(merged.quality.enginesUsed, ['groq:whisper-large-v3-turbo', 'local:ggml-base.bin'], 'the window\'s engine is added, never hidden');
  assert.deepEqual(merged.quality.lowConfidence, [{ start: 5, end: 8, reason: 'low_confidence' }], 'the window\'s doubtful stretch is re-done');
  assert.deepEqual(merged.providers, { groq: 2 });
  assert.equal(merged.engine, 'mixed', 'a window read locally in a cloud transcript');
  assert.deepEqual(merged.gaps.map(g => [g.start, g.end]), [[1200, 1800]]);
  assert.equal(merged.partial, true);
  // Nothing skipped: the refined result read (or reused) every piece, its summary is the file's.
  const whole = { ...refined, refineSkipped: undefined, segments: [...previous.segments.filter(seg => seg.start !== 720), refined.segments[0]] };
  delete whole.refineSkipped;
  const replaced = q.spliceRefinedRange(previous, whole, { start: 700, end: 760 });
  assert.equal(replaced.quality.level, 'alta');
  assert.deepEqual(replaced.providers, { local: 1 });
  assert.equal(replaced.engine, 'local');
});

test('refineHeardNothing: the stretch a refine would replace holds no text and was read (no gap of its own there)', () => {
  const previous = LECTURE();
  const range = { start: 700, end: 760 };
  const silent = { ok: true, durationSec: 1800, gaps: [], segments: [{ start: 0, end: 10, text: 'Buenos días.' }, { start: 1500, end: 1510, text: 'Hasta mañana.' }] };
  assert.equal(q.refineHeardNothing(previous, silent, range), true, 'pieces outside reused: still the window\'s verdict');
  assert.equal(q.refineHeardNothing(previous, { ...silent, refineSkipped: 2, refineSpans: [[600, 1200]], segments: [{ start: 1000, end: 1010, text: 'Otra cosa.' }] }, range), true,
    'speech elsewhere in the piece read again says nothing about the window');
  assert.equal(q.refineHeardNothing(previous, { ...silent, segments: [...silent.segments, { start: 722, end: 728, text: 'Hola.' }] }, range), false);
  assert.equal(q.refineHeardNothing(previous, { ...silent, gaps: [{ start: 600, end: 1200, reason: 'timeout' }] }, range), false, 'unread is not silent');
  assert.equal(q.refineHeardNothing(null, silent, range), false, 'a transcript replaced whole is judged on its own');
});

test('a refine that reads its window again and hears nothing fails «no speech» even when the other pieces were reused', async () => {
  // Pieces outside the window reused (nothing skipped): the result has their text, none in the window.
  const silentWindow = () => ({ ...LECTURE(), segments: LECTURE().segments.filter(seg => seg.start !== 720) });
  const { f, transcriptStore } = readyLecture({ processFile: async () => ({ success: true, extractedText: 'x', transcription: silentWindow() }) });
  const before = { ...f.rows.get('clase') };
  const sidecarBefore = transcriptStore.sidecars.get('clase');
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 760 }, deliveryId: 'dlv_n' });
  const job = f.longJobs.get(jobId);
  await assert.rejects(f.service.processMediaJob(job), { code: 'no_speech' });
  assert.deepEqual(f.rows.get('clase'), before, 'the stored text in the window stays');
  assert.equal(transcriptStore.sidecars.get('clase'), sidecarBefore);
  assert.equal(transcriptStore.calls.sidecars.length, 0);
  assert.equal(transcriptStore.calls.analyses.length, 0);
  assert.equal(job.discarded, true);
  await flush();
  assert.deepEqual(f.terminal.at(-1), { fileId: 'clase', userId: 'u1', stage: 'failed', refine: true, range: { start: 700, end: 760 },
    deliveryId: 'dlv_n', ok: false, code: 'no_speech' });
});

// The real engine behind the queue (fake cut, fake cloud rung, memory checkpoint).
const audioEngine = require('../src/services/audio-transcriber');

function engineSegmenter(t, offsets, total) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-seg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, segments: offsets.map((offset, i) => {
      const p = path.join(dir, `seg-${String(i).padStart(4, '0')}.flac`);
      fs.writeFileSync(p, `segment-${i}`);
      return { path: p, index: i, offsetSeconds: offset, durationSeconds: (offsets[i + 1] ?? total) - offset };
    }) };
  };
}

/** A cloud rung that answers each piece with handler(index). */
function engineSdk(handler) {
  return { audio: { transcriptions: { async create(request) {
    const match = /segment-(\d+)/.exec(String(request.file.name));
    return handler(match ? Number(match[1]) - 1 : -1);
  } } } };
}

function engineCheckpoint() {
  const saved = new Map();
  return { saved, dir: null, clear: async () => {},
    async load(index, meta) { const entry = saved.get(index); return entry && entry.meta.total === meta.total ? entry.part : null; },
    async save(index, meta, part) { saved.set(index, { meta, part: JSON.parse(JSON.stringify(part)) }); } };
}

/** A ready recording whose stored transcript is `first` (an engine result), refined by the real engine with `engineOpts`. */
function engineRefine(t, first, engineOpts) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-')), 'clase.wav');
  fs.writeFileSync(file, 'fake-media');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const transcriptStore = fakeStore({ durations: new Map([['clase', 1800]]) });
  transcriptStore.sidecars.set('clase', store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: { ...first, source: 'asr' } })));
  const f = fixture([row('clase', { originalName: 'clase.wav', mimeType: 'audio/wav', size: 400_000_000, path: file, processingStage: 'ready',
    extractedText: 'texto guardado' })], {
    transcriptStore,
    createCheckpoint: () => engineOpts.checkpoint,
    processFile: async (input, opts) => {
      // The queue's checkpoint, as fileProcessor passes it (a refine hands the engine a staging copy).
      const result = await audioEngine.transcribe(input.path, input.mimetype, input.originalname, { ...engineOpts, ...opts, checkpoint: opts.checkpoint || engineOpts.checkpoint });
      return result.ok ? { success: true, extractedText: result.transcript, transcription: result } : { success: false, code: result.reasonCode, error: 'x' };
    },
  });
  return { f, transcriptStore, file };
}

const ENGINE_SENTENCES = ['La oferta agregada depende de los costos de producción.', 'Cuando sube la tasa de interés, la inversión privada disminuye.',
  'El banco central publicó su informe trimestral.'];
const engineBase = (t, extra = {}) => ({ env: { GROQ_API_KEY: 'gsk_lanes', TRANSCRIBE_PROVIDERS: 'groq' }, durationSeconds: 1800, createFile: (buffer, name, mime) => ({ name, mime, body: String(buffer) }),
  ffmpegFilters: [], parallel: 1, language: 'es', sleep: async () => {}, segmentAudio: engineSegmenter(t, [0, 600, 1200], 1800), ...extra });
const sentence = (i, extra = '') => ({ text: `${ENGINE_SENTENCES[i]}${extra}`, segments: [{ start: 1, end: 500, text: `${ENGINE_SENTENCES[i]}${extra}` }] });

test('a refine of a partial transcript keeps the file\'s quality summary: the window\'s «alta» never hides a gap (end to end)', async (t) => {
  audioEngine.clearTranscriptionCooldowns();
  const checkpoint = engineCheckpoint();
  const failing = engineSdk(i => { if (i === 2) throw Object.assign(new Error('boom'), { status: 400 }); return sentence(i); });
  const firstFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-')), 'clase.wav');
  fs.writeFileSync(firstFile, 'fake-media');
  t.after(() => fs.rmSync(path.dirname(firstFile), { recursive: true, force: true }));
  const first = await audioEngine.transcribe(firstFile, 'audio/wav', 'clase.wav', { ...engineBase(t), minCoverage: 0.5, checkpoint, groqClient: failing });
  assert.equal(first.partial, true);
  assert.equal(first.quality.level, 'media');
  const { f, transcriptStore } = engineRefine(t, first, { ...engineBase(t), minCoverage: 0.5, checkpoint,
    groqClient: engineSdk(i => { if (i === 2) throw Object.assign(new Error('boom'), { status: 400 }); return sentence(i, ' Corregido.'); }) });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 900 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  const saved = transcriptStore.sidecars.get('clase');
  assert.ok(saved.segments.some(seg => /Corregido/.test(seg.text)), 'the window was refined');
  assert.deepEqual(saved.gaps.map(g => [g.start, g.end]), [[1200, 1800]]);
  assert.equal(saved.quality.level, first.quality.level, 'the file-level level stays');
  assert.equal(saved.quality.score, first.quality.score);
  assert.deepEqual(saved.providers, first.providers);
  assert.equal(transcriptStore.calls.analyses.at(-1).result.quality.level, first.quality.level);
});

test('a silent window ends «no speech» in both modes: other pieces reused (parts kept) or skipped (parts swept) (end to end)', async (t) => {
  for (const mode of ['reuse', 'skip']) {
    audioEngine.clearTranscriptionCooldowns();
    const checkpoint = engineCheckpoint();
    const firstFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-')), 'clase.wav');
    fs.writeFileSync(firstFile, 'fake-media');
    t.after(() => fs.rmSync(path.dirname(firstFile), { recursive: true, force: true }));
    const first = await audioEngine.transcribe(firstFile, 'audio/wav', 'clase.wav', { ...engineBase(t), checkpoint, groqClient: engineSdk(i => sentence(i)) });
    // The second reading of the window's piece is empty on every rung (and the room is measured silent).
    const { f, transcriptStore } = engineRefine(t, first, { ...engineBase(t), checkpoint: mode === 'reuse' ? checkpoint : engineCheckpoint(),
      measureVoiced: async () => ({ voicedSec: 0, silences: [] }), groqClient: engineSdk(i => (i === 1 ? { text: '', segments: [] } : sentence(i))) });
    const sidecarBefore = transcriptStore.sidecars.get('clase');
    const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 900 } });
    await assert.rejects(f.service.processMediaJob(f.longJobs.get(jobId)), { code: 'no_speech' }, mode);
    assert.equal(transcriptStore.sidecars.get('clase'), sidecarBefore, `${mode}: the stored transcript stays`);
    assert.equal(f.rows.get('clase').extractedText, 'texto guardado', mode);
    await flush();
    assert.equal(f.terminal.at(-1).code, 'no_speech', mode);
  }
});

test('a failed refine leaves the recording\'s checkpoint as it was: a later gap retry still rebuilds the kept text (end to end)', async (t) => {
  for (const mode of ['reuse', 'skip']) {
    audioEngine.clearTranscriptionCooldowns();
    const checkpoint = engineCheckpoint();
    const firstFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-')), 'clase.wav');
    fs.writeFileSync(firstFile, 'fake-media');
    t.after(() => fs.rmSync(path.dirname(firstFile), { recursive: true, force: true }));
    // A partial first run: piece 2 fails, pieces 0 and 1 are kept.
    const first = await audioEngine.transcribe(firstFile, 'audio/wav', 'clase.wav', { ...engineBase(t), minCoverage: 0.5, checkpoint,
      groqClient: engineSdk(i => { if (i === 2) throw Object.assign(new Error('boom'), { status: 400 }); return sentence(i); }) });
    assert.equal(first.partial, true, mode);
    const keptPart = JSON.stringify(checkpoint.saved.get(1)?.part);
    let phase = 'refine';
    // The refine hears nothing in the window's piece (and the room is measured silent).
    const sdk = engineSdk(i => (phase === 'refine' && i === 1 ? { text: '', segments: [] } : sentence(i)));
    const refineCheckpoint = mode === 'reuse' ? checkpoint : engineCheckpoint();
    const { f, transcriptStore } = engineRefine(t, first, { ...engineBase(t), minCoverage: 0.5, checkpoint: refineCheckpoint,
      measureVoiced: async () => ({ voicedSec: 0, silences: [] }), groqClient: sdk });
    Object.assign(f.rows.get('clase'), { processingError: 'Parcial: 1 de 3 tramos no se pudieron transcribir.' });
    const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 900 } });
    await assert.rejects(f.service.processMediaJob(f.longJobs.get(jobId)), { code: 'no_speech' }, mode);
    if (mode === 'reuse') assert.equal(JSON.stringify(checkpoint.saved.get(1)?.part), keptPart, 'the failed reading was never saved');
    else assert.equal(refineCheckpoint.saved.size, 0, `${mode}: nothing was saved`);
    if (mode !== 'reuse') continue;
    // «reintenta»: the gap retry rebuilds the transcript from the kept parts.
    phase = 'retry';
    Object.assign(f.rows.get('clase'), { processingStage: 'uploaded', processingError: q.RETRYING_PARTIAL });
    await f.service.processMediaJob({ id: 'retry', data: { fileId: 'clase', userId: 'u1', force: true }, opts: { attempts: 3 }, attemptsMade: 0 });
    const texts = transcriptStore.sidecars.get('clase').segments.map(seg => seg.text).join(' ');
    assert.match(texts, /Cuando sube la tasa de interés/, 'the kept sentence survives the gap retry');
  }
});

test('the staged checkpoint serves its own readings, delegates the rest, and writes only on commit', async () => {
  const real = engineCheckpoint();
  await real.save(0, { segmentSeconds: 600, total: 3, cutPlan: 'p1' }, { text: 'guardado' });
  real.savedCutPlan = async index => real.saved.get(index)?.meta?.cutPlan || null;
  const staging = q.createStagedCheckpoint(real);
  const meta = { segmentSeconds: 600, total: 3, cutPlan: 'p2' };
  assert.deepEqual(await staging.checkpoint.load(0, meta), { text: 'guardado' });
  await staging.checkpoint.save(0, meta, { text: 'nuevo' });
  assert.deepEqual(await staging.checkpoint.load(0, meta), { text: 'nuevo' });
  assert.equal(await staging.checkpoint.load(0, { segmentSeconds: 600, total: 4 }), null, 'another piece count is not served');
  assert.equal(await staging.checkpoint.savedCutPlan(0), 'p2');
  assert.deepEqual(real.saved.get(0).part, { text: 'guardado' }, 'nothing written before commit');
  await staging.commit();
  assert.deepEqual(real.saved.get(0).part, { text: 'nuevo' });
  assert.equal(q.createStagedCheckpoint(null).checkpoint, null);
});

test('a refine over a transcript cut by another plan reads the whole recording and splices exactly: no word lost or repeated (end to end)', async (t) => {
  audioEngine.clearTranscriptionCooldowns();
  // Words on the recording's clock; a cloud rung hears those inside its piece, in runs split at pauses ≥ 2 s.
  const WORDS = [[100, 'alfa'], [101, 'beta'], [102, 'gamma'], [720, 'uno'], [721, 'dos'], [722, 'tres'],
    [1196, 'cuatro'], [1197.5, 'cinco'], [1199, 'seis'], [1200.8, 'siete'], [1500, 'omega']];
  const answer = offsets => i => {
    const start = offsets[i];
    const end = offsets[i + 1] ?? 1800;
    const runs = [];
    for (const [time, word] of WORDS.filter(([time]) => time >= start && time < end)) {
      const last = runs[runs.length - 1];
      if (last && time - last.to < 2) { last.words.push(word); last.to = time; } else runs.push({ from: time, to: time, words: [word] });
    }
    const segments = runs.map(run => ({ start: Math.max(0, run.from - start - 0.1), end: run.to - start + 0.5, text: run.words.join(' ') }));
    return { text: segments.map(seg => seg.text).join(' '), segments };
  };
  // The stored transcript: cut at 610 s and 1210 s, «cuatro cinco seis siete» in one segment.
  const checkpoint = engineCheckpoint();
  const firstFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-')), 'clase.wav');
  fs.writeFileSync(firstFile, 'fake-media');
  t.after(() => fs.rmSync(path.dirname(firstFile), { recursive: true, force: true }));
  const oldCut = [0, 610, 1210];
  const first = await audioEngine.transcribe(firstFile, 'audio/wav', 'clase.wav', { ...engineBase(t), segmentAudio: engineSegmenter(t, oldCut, 1800),
    checkpoint, groqClient: engineSdk(answer(oldCut)) });
  assert.ok(first.segments.some(seg => seg.text === 'cuatro cinco seis siete' && seg.start < 1200 && seg.end > 1200));
  // The refine cuts at 600 s and 1200 s: «siete» is in the next piece.
  const newCut = [0, 600, 1200];
  const { f, transcriptStore } = engineRefine(t, first, { ...engineBase(t), segmentAudio: engineSegmenter(t, newCut, 1800),
    checkpoint, groqClient: engineSdk(answer(newCut)) });
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 700, end: 1198 } });
  await f.service.processMediaJob(f.longJobs.get(jobId));
  assert.deepEqual(wordsOf(transcriptStore.sidecars.get('clase')), WORDS.map(([, word]) => word));
  await flush();
  assert.equal(f.terminal.at(-1).ok, true);
});

test('the disk checkpoint names the cut plan of an entry its load ignores (another piece count), and nothing for a missing or broken one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sira-lanes-ckpt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkpoint = q.createDiskCheckpoint(dir);
  await checkpoint.save(0, { segmentSeconds: 600, total: 4, cutPlan: 'abc123' }, { text: 'hola', cutPlan: 'abc123' });
  assert.equal(await checkpoint.load(0, { segmentSeconds: 600, total: 3 }), null, 'another piece count is not loaded');
  assert.equal(await checkpoint.savedCutPlan(0), 'abc123');
  assert.equal(await checkpoint.savedCutPlan(1), null);
  fs.writeFileSync(path.join(dir, 'seg-00002.json'), '{broken');
  assert.equal(await checkpoint.savedCutPlan(2), null);
});

// ── refine on a link clip: the two clocks meet on the millisecond grid ──────

// A link clip's stored sidecar rounds every time to the millisecond AFTER the
// shift to the recording's clock; a refine's segments and re-read spans are
// the plain float sums (onRecordingClock). 301.228 + 600 is one of the starts
// where the two differ by an ulp (901.228 vs 901.2280000000001): compared
// exactly, the first segment of a re-read piece was kept AND swapped in, and
// the first segment of a skipped piece was swapped out and never replaced.
const round3 = n => Math.round(Number(n) * 1000) / 1000;
const CLIP_OFFSET = 600;
const CLIP_FIRST = () => ({ ok: true, durationSec: 1500, language: 'es', providers: { groq: 3 }, engine: 'cloud', partial: false, gaps: [], coverage: 1,
  segments: [{ start: 0, end: 280, text: 'cero' }, { start: 280, end: 301, text: 'uno' },
    { start: 301.228, end: 331.228, text: 'alfa beta gamma' }, { start: 331.228, end: 891.228, text: 'delta epsilon' },
    { start: 901.5, end: 1401.5, text: 'final' }],
  quality: { score: 0.9, level: 'alta', escalations: 0, enginesUsed: ['groq:whisper-large-v3-turbo'], notes: [],
    lowConfidence: [{ start: 301.228, end: 310, reason: 'low_confidence' }] } });
const storedClip = first => store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: { ...q.onRecordingClock(first, CLIP_OFFSET), source: 'asr' } }));
const refinedClip = (segments, spans, extra = {}) => q.onRecordingClock({ ok: true, durationSec: 1500, engine: 'cloud', providers: { groq: 1 }, gaps: [], coverage: 1,
  partial: false, segments, refineSkipped: 3 - spans.length, refineSpans: spans, ...extra }, CLIP_OFFSET);
const countWords = result => wordsOf(result).reduce((map, word) => map.set(word, (map.get(word) || 0) + 1), new Map());

test('spliceRefinedRange on a link clip: the first segment of the piece read again is stored once (start edge)', () => {
  const previous = storedClip(CLIP_FIRST());
  assert.equal(previous.segments[2].start, 901.228);
  assert.ok(301.228 + CLIP_OFFSET !== 901.228, 'the two clocks really differ by an ulp here');
  // Piece 1 (301.228–901.5 on the file's clock) read again, with its own doubtful stretch.
  const refined = refinedClip([{ start: 301.228, end: 331.228, text: 'alfa beta gamma' }, { start: 331.228, end: 891.228, text: 'delta epsilon' }],
    [[301.228, 901.5]], { quality: { score: 0.9, level: 'alta', lowConfidence: [{ start: 301.228, end: 310, reason: 'low_confidence' }] } });
  const range = { start: 910, end: 1000 };
  assert.equal(q.refineLosesText(previous, refined, range), false);
  const merged = q.spliceRefinedRange(previous, refined, range);
  assert.deepEqual([...countWords(merged)].filter(([, n]) => n > 1), [], 'no word repeated');
  assert.deepEqual(wordsOf(merged), ['cero', 'uno', 'alfa', 'beta', 'gamma', 'delta', 'epsilon', 'final']);
  // The old doubtful stretch is re-done, never left as a millisecond sliver next to the new one.
  assert.equal(merged.quality.lowConfidence.length, 1);
  const saved = store.normalizeSidecar(store.buildSidecar({ fileId: 'clase', userId: 'u1', result: merged }));
  assert.equal(saved.quality.lowConfidence.length, 1);
});

test('spliceRefinedRange on a link clip: the first segment of a skipped piece is never swapped out (end edge)', () => {
  const previous = storedClip(CLIP_FIRST());
  // Piece 0 read again; its last segment overruns the cut (301.228 s) into the skipped piece 1.
  const refined = refinedClip([{ start: 0, end: 285, text: 'cero nuevo' }, { start: 285, end: 302, text: 'uno nuevo' }], [[0, 301.228]]);
  const range = { start: 650, end: 895 };
  assert.equal(q.refineLosesText(previous, refined, range), false);
  const merged = q.spliceRefinedRange(previous, refined, range);
  assert.deepEqual(wordsOf(merged), ['cero', 'nuevo', 'uno', 'nuevo', 'alfa', 'beta', 'gamma', 'delta', 'epsilon', 'final']);
});

// Clip variant of the fuzz above: silence-snapped cuts on the millisecond
// grid, whisper's first segment of a piece at the piece's start, recording
// offsets of whole minutes. The stored side goes through the sidecar (round
// after the shift), the refined side through onRecordingClock (float sums).
function fuzzClipCase(rnd) {
  const offset = [600, 1800, 3600, 5400, 7200][Math.floor(rnd() * 5)];
  const pieces = [];
  let clock = 0;
  for (let i = 0; i < 6; i++) { const end = round3(clock + 60 + rnd() * 240); pieces.push({ start: clock, end }); clock = end; }
  let id = 0;
  const words = pieces.map(piece => {
    const list = [];
    let x = piece.start + 0.2 + rnd() * 0.3;
    while (x < piece.end - 0.5) { list.push({ t: x, w: `w${id++}` }); x += 0.25 + rnd() * 0.5; }
    return list;
  });
  const reading = (piece, list) => {
    const groups = [];
    let current = [];
    for (const word of list) { current.push(word); if (current.length >= 3 + Math.floor(rnd() * 25)) { groups.push(current); current = []; } }
    if (current.length) groups.push(current);
    return groups.map((group, i) => {
      const start = i === 0 && rnd() < 0.7 ? piece.start : round3(Math.max(piece.start, group[0].t - rnd() * 0.2));
      const end = i === groups.length - 1 && rnd() < 0.5 ? round3(piece.end + rnd() * 1.5) : round3(group[group.length - 1].t + 0.2 + rnd() * 0.3);
      return { start, end, text: group.map(word => word.w).join(' ') };
    });
  };
  const a = offset + rnd() * clock * 0.9;
  const b = Math.min(offset + clock, a + 5 + rnd() * 300);
  const firstSegments = [];
  const firstGaps = [];
  const refinedSegments = [];
  const refineSpans = [];
  let refineSkipped = 0;
  const expected = [];
  pieces.forEach((piece, i) => {
    const inWindow = piece.start + offset < b && piece.end + offset > a;
    const fate = inWindow ? 'reread' : (rnd() < 0.7 ? 'skipped' : 'reused');
    if (!inWindow && fate === 'skipped' && rnd() < 0.25) firstGaps.push({ start: piece.start, end: piece.end, reason: 'timeout' });
    else { firstSegments.push(...reading(piece, words[i])); expected.push(...words[i].map(word => word.w)); }
    if (fate === 'reread') { refinedSegments.push(...reading(piece, words[i])); refineSpans.push([piece.start, piece.end]); }
    else if (fate === 'reused') refinedSegments.push(...reading(piece, words[i]));
    else refineSkipped++;
  });
  if (!refineSkipped) return null;
  const first = { ok: true, durationSec: clock, gaps: firstGaps, coverage: 1, partial: firstGaps.length > 0, segments: firstSegments };
  const previous = store.normalizeSidecar(store.buildSidecar({ fileId: 'f', userId: 'u1', result: { ...q.onRecordingClock(first, offset), source: 'asr' } }));
  const refined = q.onRecordingClock({ ok: true, durationSec: clock, gaps: [], coverage: 1, partial: false, segments: refinedSegments, refineSkipped, refineSpans }, offset);
  return { previous, refined, range: { start: a, end: b }, expected };
}

test('spliceRefinedRange (fuzz, link clips): stored times rounded after the shift, refined ones not, lose and repeat no word', () => {
  let cases = 0;
  const rnd = fuzzRandom(4242);
  for (let k = 0; k < 900; k++) {
    const scenario = fuzzClipCase(rnd);
    if (!scenario) continue;
    cases++;
    const { previous, refined, range, expected } = scenario;
    const label = `clip case ${k}`;
    assert.equal(q.refineLosesText(previous, refined, range), false, label);
    const merged = q.spliceRefinedRange(previous, refined, range);
    const counts = countWords(merged);
    const lost = expected.filter(word => !counts.has(word));
    const repeated = [...counts].filter(([, n]) => n > 1).map(([word]) => word);
    assert.deepEqual({ lost, repeated }, { lost: [], repeated: [] }, label);
    assert.deepEqual(merged.gaps.map(g => [round3(g.start), round3(g.end)]), previous.gaps.map(g => [g.start, g.end]), label);
  }
  assert.ok(cases > 600, `enough skipped-piece clip refines (${cases})`);
});

test('refineHeardNothing: a reused segment crossing into the window says nothing about the stretch read again', () => {
  // Piece 0's last segment overruns the 600 s cut a little; the user asks «del minuto 10» exactly.
  const previous = { ...LECTURE(), segments: [{ start: 0, end: 10, text: 'Buenos días.' }, { start: 590, end: 600.6, text: 'Fin de la primera parte.' },
    { start: 700, end: 730, text: 'El profesor Ccori explica.' }, { start: 1500, end: 1510, text: 'Hasta mañana.' }] };
  // Parts kept: pieces 0 and 2 reused, piece 1 read again and silent.
  const reuse = { ...previous, refineSpans: [[600, 1200]], segments: [previous.segments[0], previous.segments[1], previous.segments[3]] };
  const range = { start: 600, end: 760 };
  assert.equal(q.refineHeardNothing(previous, reuse, range), true);
  // The same stretch read again with speech in it is not silent.
  const heard = { ...reuse, segments: [...reuse.segments, { start: 700, end: 731, text: 'El profesor Kori explica.' }] };
  assert.equal(q.refineHeardNothing(previous, heard, range), false);
  // A result that names no re-read stretch (a whole file read in one piece) is judged by everything it swaps in.
  const { refineSpans: _spans, ...unnamed } = reuse;
  assert.equal(q.refineHeardNothing(previous, unnamed, range), false);
});

test('a refine whose re-read window is silent next to a reused segment crossing its edge fails «no speech» and keeps the text', async () => {
  const lecture = () => ({ ...LECTURE(), segments: [{ start: 0, end: 10, text: 'Buenos días.' }, { start: 590, end: 600.6, text: 'Fin de la primera parte.' },
    { start: 700, end: 730, text: 'El profesor Ccori explica.' }, { start: 1500, end: 1510, text: 'Hasta mañana.' }] });
  const { f, transcriptStore } = refineOver(lecture(), () => {
    const result = lecture();
    // Pieces outside the window reused from their checkpoints, piece 1 read again and silent.
    return { ...result, refineSpans: [[600, 1200]], segments: result.segments.filter(seg => seg.start !== 700) };
  });
  const before = { ...f.rows.get('clase') };
  const sidecarBefore = transcriptStore.sidecars.get('clase');
  const { jobId } = await f.service.enqueueRefine({ fileId: 'clase', userId: 'u1', range: { start: 600, end: 760 } });
  await assert.rejects(f.service.processMediaJob(f.longJobs.get(jobId)), { code: 'no_speech' });
  assert.deepEqual(f.rows.get('clase'), before);
  assert.equal(transcriptStore.sidecars.get('clase'), sidecarBefore);
  assert.equal(transcriptStore.calls.sidecars.length, 0);
  await flush();
  assert.equal(f.terminal.at(-1).code, 'no_speech');
});
