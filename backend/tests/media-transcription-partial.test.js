'use strict';

// Integration of the long-media engine result into the durable media job:
// partial transcripts are kept (ready + note), their gaps are retried
// without losing the text, the segments sidecar is written before the
// terminal stage, and every terminal outcome reaches the chat delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMediaTranscriptionService, isPartialTranscript, isReprocessingPartial, transcriptTextFor,
  keytermsFromFileName, partialFailureMessage, RETRYING_PARTIAL,
} = require('../src/services/media-transcription-queue');

const NOW = Date.parse('2026-10-15T19:00:00Z');
const row = (id, extra = {}) => ({ id, userId: 'u1', originalName: `${id}.mp4`, mimeType: 'video/mp4', size: 1000,
  path: `/uploads/u1/${id}.mp4`, deletedAt: null, extractedText: null, processingError: null,
  processingStage: 'uploaded', processingStageAt: new Date(NOW - 300000), ...extra });

function longResult(overrides = {}) {
  const segments = [];
  for (let i = 0; i < 6; i++) segments.push({ start: i * 60, end: i * 60 + 50, text: `Frase número ${i + 1} de la clase.` });
  return { ok: true, method: 'local', text: segments.map(s => s.text).join(' '), transcript: segments.map(s => s.text).join(' '),
    segments, durationSec: 360, segmentCount: 6, partial: false, gaps: [], coverage: 1, providers: { local: 6 }, engine: 'local', ...overrides };
}

function fixture(initial, overrides = {}) {
  const rows = new Map(initial.map(file => [file.id, { ...file }]));
  const jobs = new Map();
  const events = [];
  const matches = (file, where) => file && file.id === where.id && file.userId === where.userId && file.deletedAt == null;
  const prisma = { file: {
    async findFirst({ where }) { const file = rows.get(where.id); return matches(file, where) ? { ...file } : null; },
    async updateMany({ where, data }) {
      const file = rows.get(where.id);
      if (!matches(file, where)) return { count: 0 };
      Object.assign(file, data);
      events.push(['update', data.processingStage || null]);
      return { count: 1 };
    },
  } };
  const queue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts, state: 'waiting', attemptsMade: 0,
        async getState() { return this.state; }, async remove() { jobs.delete(this.id); }, discard() {} };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  const cleared = [];
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue, now: () => NOW,
    validate: async (local, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: file => ({ dir: `/ckpt/${file.id}`, clear: async () => { cleared.push(file.id); } }),
    processFile: async () => ({ success: true, extractedText: longResult().text, transcription: longResult() }),
    formatter: { renderText: (result, opts) => `[header=${opts.header}] ${result.segments.map(s => `[${s.start}] ${s.text}`).join('\n')}` },
    transcriptStore: {
      async writeSidecar({ fileId }) { events.push(['sidecar', fileId]); return { path: `/uploads/.transcripts/${fileId}.json.gz` }; },
      async upsertMediaTranscriptAnalysis(_prisma, payload) { events.push(['analysis', payload.sidecarPath]); },
    },
    onTerminal: payload => { events.push(['terminal', payload.fileId, payload.stage]); },
    logger: { warn() {} },
    ...overrides,
  });
  return { service, rows, jobs, events, cleared, queue };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a long recording is stored as timestamped text; the sidecar is written before the ready stage and delivery is told', async () => {
  const f = fixture([row('clase')]);
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  await flush();
  const file = f.rows.get('clase');
  assert.equal(file.processingStage, 'ready');
  assert.equal(file.processingError, null);
  assert.match(file.extractedText, /^\[header=false\] \[0\] Frase número 1/);
  const order = f.events.map(e => e[0] === 'update' ? `update:${e[1]}` : e[0]);
  assert.ok(order.indexOf('sidecar') < order.lastIndexOf('update:ready'), `sidecar before ready: ${order}`);
  assert.deepEqual(f.events.find(e => e[0] === 'analysis'), ['analysis', '/uploads/.transcripts/clase.json.gz']);
  assert.deepEqual(f.events.find(e => e[0] === 'terminal'), ['terminal', 'clase', 'ready']);
  assert.deepEqual(f.cleared, ['clase']);
});

test('a short clip keeps plain text (no timestamps) and a missing formatter never breaks the job', async () => {
  const short = longResult({ segments: [{ start: 0, end: 20, text: 'Hola, soy una nota de voz.' }], durationSec: 20, text: 'Hola, soy una nota de voz.', transcript: 'Hola, soy una nota de voz.' });
  assert.equal(transcriptTextFor(short, 'plain', { formatter: { renderText: () => 'timed' } }), 'plain');
  assert.equal(transcriptTextFor(longResult(), 'plain', { formatter: null }), 'plain');
  assert.equal(transcriptTextFor(longResult(), 'plain', { formatter: { renderText: () => { throw new Error('boom'); } } }), 'plain');
  assert.equal(transcriptTextFor({ text: 'sin segmentos' }, 'sin segmentos', { formatter: { renderText: () => 'timed' } }), 'sin segmentos');
});

test('a partial transcript is kept as ready with an honest note, keeps its checkpoints and reaches delivery as partial', async () => {
  const partial = longResult({ partial: true, coverage: 5 / 6, gaps: [{ start: 120, end: 180, reason: 'all_providers_failed' }] });
  const f = fixture([row('clase')], { processFile: async () => ({ success: true, extractedText: partial.text, transcription: partial }) });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  await flush();
  const file = f.rows.get('clase');
  assert.equal(file.processingStage, 'ready');
  assert.match(file.processingError, /^Parcial: 1 de 6 tramos no se pudieron transcribir \(83 % transcrito\)/);
  assert.equal(isPartialTranscript(file), true);
  assert.deepEqual(f.cleared, [], 'checkpoints stay for the retry');
  assert.deepEqual(f.events.find(e => e[0] === 'terminal'), ['terminal', 'clase', 'partial']);
  assert.match(partialFailureMessage({ gaps: [] }), /^Parcial: Algunos tramos/);
});

test('retrying a partial transcript keeps the text readable, forces the job past the cache and only then marks it ready', async () => {
  const f = fixture([row('clase', { processingStage: 'ready', extractedText: 'Texto parcial de la clase.',
    processingError: 'Parcial: 1 de 6 tramos no se pudieron transcribir. Reintentar recupera solo esos tramos.' })]);
  // Without retry: still a cache hit.
  assert.deepEqual(await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' }), { id: 'clase', queued: false, stage: 'ready' });
  const queued = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true });
  assert.equal(queued.queued, true);
  const file = f.rows.get('clase');
  assert.equal(file.extractedText, 'Texto parcial de la clase.', 'the partial text is never erased');
  assert.equal(file.processingError, RETRYING_PARTIAL);
  assert.equal(isReprocessingPartial(file), true);
  const job = [...f.jobs.values()][0];
  assert.equal(job.data.force, true);
  // A second retry while the first is waiting does not stack jobs.
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true })).queued, true);
  assert.equal(f.jobs.size, 1);
  const result = await f.service.processMediaJob(job);
  assert.equal(result.stage, 'ready');
  assert.equal(f.rows.get('clase').processingError, null);
  assert.match(f.rows.get('clase').extractedText, /Frase número 6/);
});

test('a failed retry of a partial transcript restores the partial text and its note instead of failing the file', async () => {
  const note = 'Parcial: 1 de 6 tramos no se pudieron transcribir. Reintentar recupera solo esos tramos.';
  const f = fixture([row('clase', { processingStage: 'ready', extractedText: 'Texto parcial.', processingError: note })],
    { processFile: async () => ({ success: false, code: 'audio_decode_failed', error: 'dañado' }) });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true });
  await assert.rejects(f.service.processMediaJob([...f.jobs.values()][0]));
  await flush();
  const file = f.rows.get('clase');
  assert.equal(file.processingStage, 'ready');
  assert.equal(file.processingError, note);
  assert.equal(file.extractedText, 'Texto parcial.');
  assert.deepEqual(f.events.find(e => e[0] === 'terminal'), ['terminal', 'clase', 'partial']);
});

test('a terminal failure reaches delivery; a retryable one does not', async () => {
  let attempt = 0;
  const f = fixture([row('clase')], { processFile: async () => { attempt++; throw Object.assign(new Error('overloaded'), { status: 503 }); } });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  await assert.rejects(f.service.processMediaJob(job));
  await flush();
  assert.equal(f.events.filter(e => e[0] === 'terminal').length, 0);
  job.attemptsMade = 2;
  await assert.rejects(f.service.processMediaJob(job));
  await flush();
  assert.deepEqual(f.events.find(e => e[0] === 'terminal'), ['terminal', 'clase', 'failed']);
  assert.equal(attempt, 2);
});

test('a sidecar or delivery failure never fails the transcription job', async () => {
  const f = fixture([row('clase')], {
    transcriptStore: { async writeSidecar() { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); }, async upsertMediaTranscriptAnalysis() { throw new Error('no'); } },
    onTerminal: async () => { throw new Error('delivery down'); },
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  const result = await f.service.processMediaJob([...f.jobs.values()][0]);
  await flush();
  assert.equal(result.stage, 'ready');
  assert.equal(f.rows.get('clase').processingStage, 'ready');
});

test('the file name lends its proper nouns to the recogniser, never generic words', () => {
  assert.deepEqual(keytermsFromFileName('Clase 12 - Bioquímica Metabólica (Dr. Pérez) final.mp4'), ['Bioquímica', 'Metabólica', 'Pérez']);
  assert.deepEqual(keytermsFromFileName('WhatsApp Audio 2026-10-15.opus'), []);
  assert.deepEqual(keytermsFromFileName(''), []);
});

test('the job passes keyterms and checkpoint to the transcriber', async () => {
  let seen = null;
  const f = fixture([row('Seminario Kubernetes Avanzado')], { processFile: async (_file, opts) => { seen = opts; return { success: true, extractedText: 'Texto suficiente.' }; } });
  await f.service.enqueueMediaTranscription({ fileId: 'Seminario Kubernetes Avanzado', userId: 'u1' });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  assert.deepEqual(seen.keyterms, ['Seminario', 'Kubernetes', 'Avanzado']);
  assert.equal(seen.checkpoint.dir, '/ckpt/Seminario Kubernetes Avanzado');
});

test('a gap retry whose job was lost is re-added by the recovery path instead of hanging forever', async () => {
  const f = fixture([row('clase', { processingStage: 'uploaded', extractedText: 'Texto parcial.', processingError: RETRYING_PARTIAL })]);
  const result = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  assert.equal(result.queued, true);
  const job = [...f.jobs.values()][0];
  assert.equal(job.data.force, true);
  assert.equal(job.data.previousError, null, 'the retry marker is never mistaken for the partial note');
  // While that job waits, another enqueue does not stack a second one.
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  assert.equal(f.jobs.size, 1);
});

test('deleting the file during a long transcription aborts the job (no wasted hours, no write)', async () => {
  let release;
  const f = fixture([row('clase')], {
    ownershipCheckMs: 10,
    processFile: (_file, { signal }) => new Promise((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  // The ownership timer is unref'd (it never keeps a process alive); keep
  // the test's event loop alive while the fake transcription hangs.
  const keepAlive = setInterval(() => {}, 1000);
  const running = f.service.processMediaJob([...f.jobs.values()][0]);
  await new Promise(resolve => setTimeout(resolve, 5));
  f.rows.get('clase').deletedAt = new Date();
  try {
    await assert.rejects(running, { code: 'media_not_found' });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(f.rows.get('clase').extractedText, null);
  assert.deepEqual(f.cleared, ['clase'], 'its checkpoints go with it');
  assert.ok(release);
});

test('each finished job logs one line with numbers only (never transcript text)', async () => {
  const lines = [];
  const f = fixture([row('clase')], { logger: { info: line => lines.push(line), warn: line => lines.push(line) } });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await f.service.processMediaJob([...f.jobs.values()][0]);
  const line = lines.find(l => l.startsWith('[media-transcription]'));
  assert.match(line, /file=clase outcome=ready elapsedMs=\d+ durationSec=360 coverage=1\.000 engine=local providers=local:6 gaps=0 chars=\d+/);
  assert.doesNotMatch(line, /Frase/);
});

test('low coverage is retryable (only the missing segments are redone) and says so', async () => {
  const { isTransientMediaError } = require('../src/services/media-transcription-queue');
  assert.equal(isTransientMediaError({ code: 'low_coverage' }), true);
  const f = fixture([row('clase')], { processFile: async () => ({ success: false, code: 'low_coverage', error: 'pocos tramos' }) });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  await assert.rejects(f.service.processMediaJob(job));
  assert.equal(f.rows.get('clase').processingStage, 'uploaded', 'scheduled for another attempt');
  assert.deepEqual(f.cleared, [], 'checkpoints are kept for the retry');
  job.attemptsMade = 2;
  await assert.rejects(f.service.processMediaJob(job));
  assert.match(f.rows.get('clase').processingError, /Reintentar recupera solo los tramos que faltan/);
});

test('progress maps the engine stages: resuming keeps its percent, done is 99, gaps are counted', () => {
  const { createProgressTracker } = require('../src/services/media-transcription-queue');
  const published = [];
  let t = 0;
  const track = createProgressTracker({ publish: p => published.push(p), now: () => (t += 5000), intervalMs: 0 });
  track({ stage: 'resuming', completed: 10, total: 30, durationSeconds: 18000 });
  track({ stage: 'transcribe', completed: 11, total: 30, gaps: 1, durationSeconds: 18000 });
  track({ stage: 'done', completed: 30, total: 30, gaps: 1, durationSeconds: 18000 });
  assert.equal(published[0].stage, 'resuming');
  assert.equal(published[0].percent, 34);
  assert.equal(published[1].gaps, 1);
  assert.equal(published[2].percent, 99);
});

// ── review fixes: the row is the source of truth for a gap retry ────────────

const PARTIAL_NOTE = 'Parcial: 3 de 30 tramos no se pudieron transcribir (90 % transcrito). Reintentar recupera solo esos tramos.';

test('a gap retry replayed after it finished is a cache hit: nothing is re-transcribed or relabelled', async () => {
  let calls = 0;
  const f = fixture([row('clase', { processingStage: 'ready', extractedText: 'Texto parcial.', processingError: PARTIAL_NOTE })],
    { processFile: async () => { calls++; return { success: true, extractedText: longResult().text, transcription: longResult() }; } });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true });
  const job = [...f.jobs.values()][0];
  assert.equal(job.data.force, true);
  await f.service.processMediaJob(job);
  assert.equal(calls, 1);
  assert.equal(f.rows.get('clase').processingError, null, 'the retry recovered every gap');
  const complete = f.rows.get('clase').extractedText;
  // A hard kill during the offload: BullMQ replays the same forced job.
  const replay = await f.service.processMediaJob(job);
  assert.deepEqual(replay, { id: 'clase', cached: true, stage: 'ready' });
  assert.equal(calls, 1, 'the finished file is never transcribed again');
  assert.equal(f.rows.get('clase').processingStage, 'ready');
  assert.equal(f.rows.get('clase').processingError, null);
  assert.equal(f.rows.get('clase').extractedText, complete);

  // A replay over a result that is still partial keeps its honest note.
  Object.assign(f.rows.get('clase'), { processingError: PARTIAL_NOTE });
  assert.equal((await f.service.processMediaJob(job)).cached, true);
  assert.equal(f.rows.get('clase').processingError, PARTIAL_NOTE);
  assert.equal(calls, 1);
});

test('any job that meets the gap-retry marker runs the gap retry, even one queued without `force`', async () => {
  const f = fixture([row('clase', { processingStage: 'uploaded', extractedText: 'Texto parcial.', processingError: RETRYING_PARTIAL })]);
  const result = await f.service.processMediaJob({ data: { fileId: 'clase', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0 });
  assert.equal(result.stage, 'ready');
  assert.match(f.rows.get('clase').extractedText, /Frase número 6/);
  assert.equal(f.rows.get('clase').processingError, null);
});

test('a deploy that parks a gap retry keeps the retry marker, so recovery never passes the old partial off as complete', async () => {
  const { DelayedError } = require('bullmq');
  const f = fixture([row('clase', { processingStage: 'ready', extractedText: 'Texto parcial.', processingError: PARTIAL_NOTE })], {
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true });
  const job = [...f.jobs.values()][0];
  job.moveToDelayed = async () => { job.state = 'delayed'; };
  const running = f.service.processMediaJob(job, 'lock-token');
  await flush();
  assert.equal(f.service.abortActive(), 1);
  await assert.rejects(running, err => err instanceof DelayedError);
  const parked = f.rows.get('clase');
  assert.equal(parked.processingStage, 'uploaded');
  assert.equal(parked.processingError, RETRYING_PARTIAL, 'the marker survives the park');
  assert.equal(isReprocessingPartial(parked), true);
  assert.equal(parked.extractedText, 'Texto parcial.');
  // The recovery sweep (past its grace) re-enqueues the file: it stays a
  // gap retry in flight instead of turning `ready` with no partial note.
  const recovered = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  assert.equal(recovered.queued, true);
  assert.equal(f.rows.get('clase').processingStage, 'uploaded');
  assert.equal(f.rows.get('clase').processingError, RETRYING_PARTIAL);
});

test('a claimed forced job that is parked or aborted keeps the gap-retry marker', async () => {
  const { DelayedError } = require('bullmq');
  let releaseLoad;
  const f = fixture([row('clase', { processingStage: 'uploaded', extractedText: 'Texto parcial.', processingError: RETRYING_PARTIAL })]);
  const service = createMediaTranscriptionService({
    prisma: { file: {
      findFirst: () => new Promise(resolve => { releaseLoad = () => resolve({ ...f.rows.get('clase') }); }),
      updateMany: async ({ data }) => { Object.assign(f.rows.get('clase'), data); return { count: 1 }; },
    } },
    getQueue: () => f.queue, now: () => NOW, ownershipCheckMs: 0,
    processFile: async () => { throw new Error('not reached'); },
  });
  const job = { data: { fileId: 'clase', userId: 'u1', force: true }, opts: { attempts: 3 }, attemptsMade: 0,
    moveToDelayed: async () => {} };
  const running = service.processMediaJob(job, 'lock-token');
  await flush();
  assert.equal(service.abortActive(), 1);
  releaseLoad();
  await assert.rejects(running, err => err instanceof DelayedError);
  assert.equal(f.rows.get('clase').processingError, RETRYING_PARTIAL);
  assert.equal(f.rows.get('clase').processingStage, 'uploaded');

  // Same abort, but Redis is already gone (no park): the next attempt
  // still finds the marker instead of a row with the note wiped.
  job.moveToDelayed = async () => { throw new Error('Connection is closed.'); };
  const again = service.processMediaJob(job, 'lock-token');
  await flush();
  service.abortActive();
  releaseLoad();
  await assert.rejects(again, { code: 'media_shutdown' });
  assert.equal(f.rows.get('clase').processingError, RETRYING_PARTIAL);
  assert.equal(isReprocessingPartial(f.rows.get('clase')), true);
});

test('a job that fails before it claims the row writes nothing: a DB blip never wipes the gap-retry marker', async () => {
  const { DelayedError } = require('bullmq');
  const dbDown = () => Object.assign(new Error('db'), { code: 'P1001' });
  const f = fixture([row('clase', { processingStage: 'uploaded', extractedText: 'Texto parcial.', processingError: RETRYING_PARTIAL })]);
  const writes = [];
  let holdLoad = false;
  let failLoad = null;
  const service = createMediaTranscriptionService({
    prisma: { file: {
      findFirst: () => (holdLoad
        ? new Promise((_resolve, reject) => { failLoad = () => reject(dbDown()); })
        : Promise.reject(dbDown())),
      updateMany: async ({ data }) => { writes.push(data); Object.assign(f.rows.get('clase'), data); return { count: 1 }; },
    } },
    getQueue: () => f.queue, now: () => NOW, ownershipCheckMs: 0,
    processFile: async () => { throw new Error('not reached'); },
  });
  const job = { data: { fileId: 'clase', userId: 'u1', force: true }, opts: { attempts: 3 }, attemptsMade: 0 };
  // The row lookup fails at the start of a gap-retry job: the next attempt
  // must still find the marker.
  await assert.rejects(service.processMediaJob(job), { code: 'P1001' });
  assert.deepEqual(writes, []);
  assert.equal(isReprocessingPartial(f.rows.get('clase')), true);

  // A deploy aborts the job while that lookup is pending, and the lookup then
  // fails: the job is parked and the unclaimed row is left as it was.
  holdLoad = true;
  job.moveToDelayed = async () => {};
  const running = service.processMediaJob(job, 'lock-token');
  await flush();
  assert.equal(service.abortActive(), 1);
  failLoad();
  await assert.rejects(running, err => err instanceof DelayedError);
  assert.deepEqual(writes, []);
  assert.equal(f.rows.get('clase').processingError, RETRYING_PARTIAL);
  assert.equal(f.rows.get('clase').processingStage, 'uploaded');
});

test('«reintenta» while the finished job is still offloading is not swallowed: the gap retry runs once that job completes', async () => {
  const f = fixture([row('clase', { processingStage: 'ready', extractedText: 'Texto parcial.', processingError: PARTIAL_NOTE })]);
  // The original job wrote ready + «Parcial:» and is uploading the binary.
  const active = await f.queue.add('transcribe', { fileId: 'clase', userId: 'u1' }, { jobId: require('../src/services/media-transcription-queue').jobIdFor('clase', 'u1') });
  active.state = 'active';
  const answer = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1', retry: true });
  assert.deepEqual(answer, { id: 'clase', queued: true, stage: 'uploaded' });
  const marked = f.rows.get('clase');
  assert.equal(isReprocessingPartial(marked), true, 'the request is recorded on the row, not dropped');
  assert.equal(marked.extractedText, 'Texto parcial.', 'the partial text stays readable');
  // The active job completes; the recovery sweep re-enqueues the file.
  active.state = 'completed';
  const recovered = await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  assert.equal(recovered.queued, true);
  const retry = [...f.jobs.values()][0];
  assert.notEqual(retry, active);
  assert.equal(retry.data.force, true);
  await f.service.processMediaJob(retry);
  assert.equal(f.rows.get('clase').processingError, null);
  assert.match(f.rows.get('clase').extractedText, /Frase número 6/);
});

test('a file deleted between the sidecar write and the ready write takes its sidecar with it', async () => {
  const purged = [];
  const f = fixture([row('clase')], {
    transcriptStore: {
      async writeSidecar({ fileId }) { f.rows.get(fileId).deletedAt = new Date(); return { path: `/x/${fileId}.json.gz` }; },
      async upsertMediaTranscriptAnalysis() {},
      async purgeMediaTranscript(fileId) { purged.push(fileId); },
    },
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  await assert.rejects(f.service.processMediaJob([...f.jobs.values()][0]), { code: 'media_not_found' });
  assert.deepEqual(purged, ['clase']);
  assert.equal(f.rows.get('clase').extractedText, null);
});

test('a job for a deleted file that never wrote a sidecar leaves existing transcripts alone', async () => {
  const purged = [];
  const f = fixture([row('clase', { deletedAt: new Date() })], {
    transcriptStore: { async writeSidecar() {}, async upsertMediaTranscriptAnalysis() {}, async purgeMediaTranscript(fileId) { purged.push(fileId); } },
  });
  await assert.rejects(f.service.processMediaJob({ data: { fileId: 'clase', userId: 'u1' } }), { code: 'media_not_found' });
  assert.deepEqual(purged, []);
});

// ── link clips: the stored transcript follows the recording's clock ────────

function clipFixture(extra = {}) {
  const sidecars = [];
  const offsets = new Map();
  const clip = longResult({ durationSec: 1800 });
  const f = fixture([row('tramo', extra.row || {})], {
    processFile: async () => ({ success: true, extractedText: clip.text, transcription: longResult({ durationSec: 1800, ...(extra.result || {}) }) }),
    transcriptStore: {
      async writeSidecar({ fileId, result }) { sidecars.push(result); return { path: `/x/${fileId}.json.gz` }; },
      async upsertMediaTranscriptAnalysis() {},
      async readMediaClipOffset({ fileId, userId }) { return offsets.get(`${userId}:${fileId}`) || 0; },
    },
  });
  return { ...f, sidecars, offsets };
}

test('a link clip is stored on the recording clock: the job offset moves text, gaps and sidecar once', async () => {
  const f = clipFixture({ result: { partial: true, coverage: 5 / 6, gaps: [{ start: 120, end: 180, reason: 'timeout' }] } });
  await f.service.enqueueMediaTranscription({ fileId: 'tramo', userId: 'u1', timeOffsetSec: 3600 });
  const job = [...f.jobs.values()][0];
  assert.equal(job.data.timeOffsetSec, 3600, 'the offset travels with the job');
  await f.service.processMediaJob(job);
  const text = f.rows.get('tramo').extractedText;
  assert.match(text, /^\[header=false\] \[3600\] Frase número 1/);
  assert.match(text, /\[3900\] Frase número 6/);
  assert.equal(f.sidecars.length, 1);
  const stored = f.sidecars[0];
  assert.equal(stored.timeOffsetSec, 3600);
  assert.equal(stored.durationSec, 1800, 'the clip keeps its own length');
  assert.deepEqual(stored.segments.map(s => s.start), [3600, 3660, 3720, 3780, 3840, 3900]);
  assert.deepEqual(stored.gaps, [{ start: 3720, end: 3780, reason: 'timeout' }]);

  // «reintenta»: the gap retry finds the offset in the durable record and
  // shifts the engine's fresh clip-clock result once, not twice.
  job.state = 'completed';
  f.offsets.set('u1:tramo', 3600);
  await f.service.enqueueMediaTranscription({ fileId: 'tramo', userId: 'u1', retry: true });
  const retry = [...f.jobs.values()][0];
  assert.equal(retry.data.timeOffsetSec, undefined);
  await f.service.processMediaJob(retry);
  assert.deepEqual(f.sidecars[1].segments.map(s => s.start), [3600, 3660, 3720, 3780, 3840, 3900]);
  assert.match(f.rows.get('tramo').extractedText, /^\[header=false\] \[3600\] Frase número 1/);
});

test('a lost clip job re-queued with only { fileId, userId } still uses the durable offset', async () => {
  const f = clipFixture({ row: { processingStage: 'extracting' } });
  f.offsets.set('u1:tramo', 5400);
  // The recovery sweep's call.
  await f.service.enqueueMediaTranscription({ fileId: 'tramo', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  assert.deepEqual(job.data, { fileId: 'tramo', userId: 'u1' });
  await f.service.processMediaJob(job);
  assert.match(f.rows.get('tramo').extractedText, /^\[header=false\] \[5400\] Frase número 1/);
  assert.equal(f.sidecars[0].timeOffsetSec, 5400);
});

test('a job offset of 0 wins over the durable record; a recording without a clip is never moved', async () => {
  const f = clipFixture();
  f.offsets.set('u1:tramo', 3600);
  await f.service.processMediaJob({ data: { fileId: 'tramo', userId: 'u1', timeOffsetSec: 0 } });
  assert.match(f.rows.get('tramo').extractedText, /^\[header=false\] \[0\] Frase número 1/);
  assert.equal(f.sidecars[0].timeOffsetSec, undefined);
  const { onRecordingClock } = require('../src/services/media-transcription-queue');
  const once = onRecordingClock(longResult(), 60);
  assert.equal(onRecordingClock(once, 60), once, 'a shifted result is never shifted again');
  assert.equal(onRecordingClock(longResult(), 0).timeOffsetSec, undefined);
});
