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
