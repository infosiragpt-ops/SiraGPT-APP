'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Readable } = require('node:stream');
const {
  createMediaTranscriptionService, isMediaFile, hasTranscript, jobIdFor,
  isTransientMediaError, materializeMedia, CONCURRENCY,
} = require('../src/services/media-transcription-queue');

const NOW = Date.parse('2026-09-21T19:00:00Z');
function row(id, extra = {}) {
  return { id, userId: 'u1', originalName: `${id}.mp3`, mimeType: 'audio/mpeg', size: 1000,
    path: `/uploads/u1/${id}.mp3`, deletedAt: null, extractedText: null,
    processingStage: 'uploaded', processingStageAt: new Date(NOW - 300000), ...extra };
}

function fixture(initial, overrides = {}) {
  const rows = new Map(initial.map(file => [file.id, { ...file }]));
  const jobs = new Map();
  const calls = { processed: [], cleaned: [], retries: [], adds: 0, discarded: [] };
  const matches = (file, where) => file && file.id === where.id && file.userId === where.userId && file.deletedAt == null;
  const prisma = { file: {
    async findFirst({ where }) { const file = rows.get(where.id); return matches(file, where) ? { ...file } : null; },
    async updateMany({ where, data }) {
      const file = rows.get(where.id);
      if (!matches(file, where)) return { count: 0 };
      Object.assign(file, data);
      return { count: 1 };
    },
    async findMany({ where, cursor, take }) {
      return [...rows.values()].filter(file => !file.deletedAt && where.processingStage.in.includes(file.processingStage)
        && (!file.processingStageAt || file.processingStageAt.getTime() < NOW - 120000)
        && (!cursor || file.id > cursor.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(file => ({ ...file }));
    },
  } };
  const queue = {
    async getJob(id) { return jobs.get(id); },
    async add(name, data, opts) {
      if (jobs.has(opts.jobId)) return jobs.get(opts.jobId);
      calls.adds++;
      const job = { id: opts.jobId, name, data, opts, state: 'waiting', attemptsMade: 0,
        async getState() { return this.state; },
        async remove() { jobs.delete(this.id); },
        async retry(state, options) { calls.retries.push({ state, options }); this.state = 'waiting'; this.attemptsMade = 0; },
        discard() { calls.discarded.push(data.fileId); },
      };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue,
    now: () => NOW, validate: async (local, file) => file.mimeType,
    offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => { calls.cleaned.push(source); } }),
    processFile: async (file, { signal }) => { assert.equal(signal.aborted, false); calls.processed.push(file.path); return { success: true, extractedText: `Texto completo de ${file.originalname}` }; },
    ...overrides,
  });
  return { service, rows, jobs, calls, queue, prisma };
}

test('media detection supports audio, video and octet-stream recordings but not arbitrary documents', () => {
  for (const file of [row('a'), row('b', { mimeType: 'video/mp4' }), row('c', { mimeType: 'application/octet-stream', originalName: 'VOZ.OPUS' })]) assert.equal(isMediaFile(file), true);
  assert.equal(isMediaFile({ mimeType: 'application/pdf', originalName: 'document.pdf' }), false);
  assert.equal(hasTranscript({ extractedText: 'Media file "a.mp3" — transcription unavailable. Type: audio/mpeg' }), false);
  assert.equal(hasTranscript({ extractedText: 'partial text', processingStage: 'failed' }), false);
  for (const extractedText of ['Audio MP3 — prueba.mp3\nEstado: Transcripción no disponible.',
    'Audio WAV — prueba.wav\nEstado: No se detectó voz.', 'Audio WAV\nEstado: El archivo supera el tamaño máximo.']) assert.equal(hasTranscript({ extractedText }), false);
  assert.doesNotMatch(jobIdFor('f:1', 'u:1'), /:/);
  assert.notEqual(jobIdFor('f:1', 'u:1'), jobIdFor('f:1', 'u:2'));
});

test('50 media uploads become 50 deterministic jobs; duplicate enqueue and worker replay cost no extra transcription', async () => {
  const f = fixture(Array.from({ length: 50 }, (_, i) => row(`audio-${String(i).padStart(2, '0')}`)));
  for (const file of f.rows.values()) {
    const result = await f.service.enqueueMediaTranscription({ fileId: file.id, userId: 'u1' });
    assert.equal(result.queued, true);
  }
  await Promise.all([...f.rows.keys()].map(fileId => f.service.enqueueMediaTranscription({ fileId, userId: 'u1' })));
  assert.equal(f.jobs.size, 50);
  const allJobs = [...f.jobs.values()];
  for (let offset = 0; offset < allJobs.length; offset += CONCURRENCY) {
    await Promise.all(allJobs.slice(offset, offset + CONCURRENCY).map(job => f.service.processMediaJob(job)));
  }
  assert.equal(f.calls.processed.length, 50);
  assert.equal(f.calls.cleaned.length, 50);
  assert.ok([...f.rows.values()].every(file => file.processingStage === 'ready' && file.extractedText.endsWith(`${file.id}.mp3`)));
  assert.equal((await f.service.processMediaJob(allJobs[0])).cached, true);
  assert.equal(f.calls.processed.length, 50);
  assert.deepEqual(await f.service.enqueueMediaTranscription({ fileId: 'audio-00', userId: 'u1' }), { id: 'audio-00', queued: false, stage: 'ready' });
});

test('one corrupt recording fails only that file and is not automatically re-enqueued', async () => {
  const f = fixture([row('valid'), row('corrupt')], { processFile: async file => file.originalname === 'corrupt.mp3'
    ? { success: false, extractedText: '', code: 'audio_decode_failed', error: 'Archivo dañado.' }
    : { success: true, extractedText: 'Texto completo.' } });
  for (const fileId of ['valid', 'corrupt']) await f.service.enqueueMediaTranscription({ fileId, userId: 'u1' });
  const results = await Promise.allSettled([...f.jobs.values()].map(job => f.service.processMediaJob(job)));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(f.rows.get('valid').processingStage, 'ready');
  assert.equal(f.rows.get('corrupt').processingStage, 'failed');
  assert.deepEqual(f.calls.discarded, ['corrupt']);
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'corrupt', userId: 'u1' })).queued, false);
});

test('transient failure schedules retry; the last attempt is terminal and cleanup always runs', async () => {
  const f = fixture([row('audio')], { processFile: async () => { throw Object.assign(new Error('provider overloaded'), { status: 503 }); } });
  await f.service.enqueueMediaTranscription({ fileId: 'audio', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  assert.equal(job.opts.attempts, 3);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 5000 });
  await assert.rejects(f.service.processMediaJob(job));
  assert.equal(f.rows.get('audio').processingStage, 'uploaded');
  assert.equal(f.calls.discarded.length, 0);
  job.attemptsMade = 2;
  await assert.rejects(f.service.processMediaJob(job));
  assert.equal(f.rows.get('audio').processingStage, 'failed');
  assert.equal(f.calls.cleaned.length, 2);
});

test('explicit retry resets attempt budget only for a failed job and discards stale partial text', async () => {
  const f = fixture([row('audio')]);
  await f.service.enqueueMediaTranscription({ fileId: 'audio', userId: 'u1' });
  const job = [...f.jobs.values()][0];
  job.state = 'failed'; job.attemptsMade = 3;
  Object.assign(f.rows.get('audio'), { processingStage: 'failed', extractedText: 'Partial output' });
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'audio', userId: 'u1' })).queued, false);
  assert.equal((await f.service.enqueueMediaTranscription({ fileId: 'audio', userId: 'u1', retry: true })).queued, true);
  assert.deepEqual(f.calls.retries, [{ state: 'failed', options: { resetAttemptsMade: true } }]);
  assert.equal(f.rows.get('audio').extractedText, null);
  assert.equal(f.jobs.size, 1);
});

test('enqueue and worker reject another owner or soft-deleted files without writes or processing', async () => {
  const f = fixture([row('owned'), row('deleted', { deletedAt: new Date() })]);
  await assert.rejects(f.service.enqueueMediaTranscription({ fileId: 'owned', userId: 'other' }), { code: 'media_not_found' });
  await assert.rejects(f.service.enqueueMediaTranscription({ fileId: 'deleted', userId: 'u1' }), { code: 'media_not_found' });
  await assert.rejects(f.service.processMediaJob({ data: { fileId: 'owned', userId: 'other' } }), { code: 'media_not_found' });
  assert.equal(f.calls.processed.length, 0);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.rows.get('owned').processingStage, 'uploaded');
});

test('deleting a file during transcription prevents persistence of its transcript', async () => {
  const f = fixture([row('audio')]);
  const service = createMediaTranscriptionService({ prisma: f.prisma, getQueue: () => f.queue,
    materialize: async source => ({ path: source, cleanup: async () => {} }), validate: async () => 'audio/mpeg',
    processFile: async () => { f.rows.get('audio').deletedAt = new Date(); return { success: true, extractedText: 'private text' }; } });
  await assert.rejects(service.processMediaJob({ data: { fileId: 'audio', userId: 'u1' } }), { code: 'media_not_found' });
  assert.equal(f.rows.get('audio').extractedText, null);
});

test('stale pending media recover after an enqueue crash, while completed, failed and fresh uploads remain untouched', async () => {
  const f = fixture([row('queued'), row('interrupted', { processingStage: 'extracting' }),
    row('failed', { processingStage: 'failed' }), row('done', { processingStage: 'ready', extractedText: 'done' }),
    row('fresh', { processingStageAt: new Date(NOW) }), row('doc', { mimeType: 'application/pdf' })]);
  assert.deepEqual(await f.service.reconcilePendingMedia(), { recovered: 2 });
  assert.deepEqual([...f.jobs.values()].map(job => job.data.fileId).sort(), ['interrupted', 'queued']);
  assert.equal(f.rows.get('failed').processingStage, 'failed');
});

test('recovery keyset pagination reaches more than 100 pending files without losing the tail', async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => row(`media-${String(i).padStart(3, '0')}`)));
  assert.deepEqual(await f.service.reconcilePendingMedia(), { recovered: 205 });
  assert.equal(f.jobs.size, 205);
});

test('Redis absence is an honest enqueue error and does not erase a persisted upload', async () => {
  const f = fixture([row('audio')], { getQueue: () => { throw Object.assign(new Error('Redis unavailable'), { code: 'media_queue_unavailable' }); } });
  await assert.rejects(f.service.enqueueMediaTranscription({ fileId: 'audio', userId: 'u1' }), { code: 'media_queue_unavailable' });
  assert.equal(f.rows.get('audio').path, '/uploads/u1/audio.mp3');
  assert.equal(f.rows.get('audio').processingStage, 'uploaded');
});

test('an empty or legacy placeholder extraction is never marked ready', async () => {
  for (const extractedText of ['', 'Media file "a.mp3" — transcription unavailable. Type: audio/mpeg']) {
    const f = fixture([row('audio')], { processFile: async () => ({ success: true, extractedText }) });
    await assert.rejects(f.service.processMediaJob({ data: { fileId: 'audio', userId: 'u1' } }));
    assert.equal(f.rows.get('audio').processingStage, 'failed');
    assert.equal(f.rows.get('audio').extractedText, null);
  }
});

test('timeout abort reaches the processor and scratch media is cleaned without false success', async () => {
  const f = fixture([row('audio')], { timeoutMs: 10, processFile: async (file, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  // Keep this test alive while the production timeout remains unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(f.service.processMediaJob({ data: { fileId: 'audio', userId: 'u1' }, attemptsMade: 2 }), { code: 'media_timeout' });
  } finally { clearTimeout(keepAlive); }
  assert.equal(f.calls.cleaned.length, 1);
  assert.equal(f.rows.get('audio').processingStage, 'failed');
});

test('remote media is streamed to scratch, and cleanup removes the downloaded file', async () => {
  const local = await materializeMedia('r2:uploads/audio.mp3', { storage: {
    isRemote: () => true, keyFromRef: () => 'uploads/audio.mp3',
    readStream: async () => ({ stream: Readable.from(['audio', '-bytes']) }),
  } });
  assert.equal(await fs.readFile(local.path, 'utf8'), 'audio-bytes');
  await local.cleanup();
  await assert.rejects(fs.stat(local.path), { code: 'ENOENT' });
});

test('transient classification never retries corrupt, unavailable files or no-speech recordings', () => {
  assert.equal(isTransientMediaError({ code: 'local_unavailable' }), true);
  assert.equal(isTransientMediaError({ code: 'provider_timeout' }), true);
  for (const code of ['audio_decode_failed', 'file_unavailable', 'file_empty', 'no_speech']) {
    assert.equal(isTransientMediaError({ code, message: 'timeout', status: 503 }), false);
  }
});

test('persist raw speech without model headers, then update the owner reference only after successful offload', async () => {
  const f = fixture([row('audio')], { processFile: async () => ({ success: true,
    extractedText: 'Transcripción, modelo: metadata\n---\nHola', transcription: { transcript: 'Hola' } }),
  offload: async file => {
    assert.equal(f.rows.get(file.id).extractedText, 'Hola');
    assert.equal(f.rows.get(file.id).processingStage, 'ready');
    return 'r2:uploads/u1/audio.mp3';
  } });
  await f.service.processMediaJob({ data: { fileId: 'audio', userId: 'u1' } });
  assert.equal(f.rows.get('audio').path, 'r2:uploads/u1/audio.mp3');
  assert.equal(f.rows.get('audio').extractedText, 'Hola');
});

test('offload failure does not invalidate a finished transcript or erase its local source', async () => {
  const f = fixture([row('audio')], { offload: async () => { throw new Error('R2 temporarily unavailable'); } });
  assert.equal((await f.service.processMediaJob({ data: { fileId: 'audio', userId: 'u1' } })).stage, 'ready');
  assert.equal(f.rows.get('audio').processingStage, 'ready');
  assert.equal(f.rows.get('audio').path, '/uploads/u1/audio.mp3');
});

test('media offload streams bytes with length and abort signal, without deleting the source prematurely', async () => {
  const os = require('node:os');
  const path = require('node:path');
  const storage = require('../src/services/object-storage');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-offload-test-'));
  const source = path.join(dir, 'audio.mp3');
  const signal = new AbortController().signal;
  await fs.writeFile(source, 'media bytes');
  storage.__setStorageForTests({ enabled: true, async put({ body, contentLength, signal: passed }) {
    assert.equal(Buffer.isBuffer(body), false);
    assert.equal(contentLength, 11);
    assert.equal(passed, signal);
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'media bytes');
  } });
  try {
    const result = await storage.persistLocalFileStream({ localPath: source, key: 'uploads/u/audio.mp3', signal });
    assert.equal(result.ref, 'r2:uploads/u/audio.mp3');
    assert.equal(await fs.readFile(source, 'utf8'), 'media bytes');
  } finally {
    storage.__setStorageForTests(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a 10-hour job gets a 12 h budget and survives many deploys (stalled ceiling)', () => {
  const q = require('../src/services/media-transcription-queue');
  assert.ok(q.PROCESS_TIMEOUT_MS >= 12 * 60 * 60 * 1000);
  assert.ok(q.MAX_STALLED_COUNT >= 20);
});

test('disk checkpoints persist each segment atomically, ignore mismatched layouts and clear on success', async (t) => {
  const os = require('node:os');
  const path = require('node:path');
  const { createDiskCheckpoint, checkpointFor, sweepStaleCheckpoints } = require('../src/services/media-transcription-queue');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-ckpt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = checkpointFor(row('clase-10h', { size: 6_000_000_000 }), root);
  assert.match(path.basename(store.dir), /^media-[a-f0-9]{64}-6000000000$/);
  const meta = { segmentSeconds: 600, total: 61 };
  await store.save(3, meta, { text: 'parte cuatro', segments: [{ start: 1, end: 2, text: 'x' }] });
  assert.deepEqual(await store.load(3, meta), { text: 'parte cuatro', segments: [{ start: 1, end: 2, text: 'x' }] });
  assert.equal(await store.load(4, meta), null);
  assert.equal(await store.load(3, { segmentSeconds: 300, total: 122 }), null, 'a different cut is never mixed in');
  assert.deepEqual((await fs.readdir(store.dir)).filter(n => n.endsWith('.tmp')), []);
  await store.clear();
  assert.equal(await store.load(3, meta), null);

  const stale = createDiskCheckpoint(path.join(root, `media-${'a'.repeat(64)}-10`));
  await stale.save(0, meta, { text: 'viejo' });
  const old = Date.now() - 20 * 24 * 60 * 60 * 1000;
  await fs.utimes(stale.dir, old / 1000, old / 1000);
  assert.deepEqual(await sweepStaleCheckpoints({ root }), { removed: 1 });
});

test('progress tracker reports %, parts and an ETA from real work only (resumed parts do not skew it)', () => {
  const { createProgressTracker } = require('../src/services/media-transcription-queue');
  let clock = 0;
  const published = [];
  const track = createProgressTracker({ publish: p => published.push(p), now: () => clock, intervalMs: 0 });
  track({ stage: 'preparing', durationSeconds: 36000 });
  assert.equal(published.at(-1).stage, 'preparing');
  assert.equal(published.at(-1).percent, 1);
  clock = 50_000;
  track({ stage: 'segments', completed: 0, total: 60, durationSeconds: 36000 });
  // 20 checkpointed segments replay instantly.
  for (let i = 1; i <= 20; i++) { clock += 5; track({ stage: 'transcribe', completed: i, total: 60, durationSeconds: 36000 }); }
  assert.equal(published.at(-1).etaSeconds, null, 'no ETA from replayed checkpoints');
  for (let i = 21; i <= 24; i++) { clock += 60_000; track({ stage: 'transcribe', completed: i, total: 60, durationSeconds: 36000 }); }
  const last = published.at(-1);
  assert.equal(last.stage, 'transcribing');
  assert.equal(last.completed, 24);
  assert.equal(last.percent, Math.round(2 + (97 * 24) / 60));
  assert.equal(last.etaSeconds, 36 * 60, '36 remaining parts at 60 s each');
  assert.equal(last.durationSeconds, 36000);
});

test('worker passes progress + checkpoint to the transcriber and stores progress on the job', async () => {
  const saved = [];
  let cleared = 0;
  const f = fixture([row('larga', { originalName: 'clase-10h.mkv', mimeType: 'video/x-matroska' })], {
    createCheckpoint: () => ({ load: async () => null, save: async (...args) => { saved.push(args); }, clear: async () => { cleared++; } }),
    processFile: async (file, { onProgress, checkpoint }) => {
      assert.equal(typeof onProgress, 'function');
      await checkpoint.save(0, { segmentSeconds: 600, total: 2 }, { text: 'a' });
      onProgress({ stage: 'segments', completed: 0, total: 2, durationSeconds: 1200 });
      onProgress({ stage: 'transcribe', completed: 1, total: 2, durationSeconds: 1200 });
      return { success: true, extractedText: 'Transcripción completa de la clase larga' };
    },
  });
  await f.service.enqueueMediaTranscription({ fileId: 'larga', userId: 'u1' });
  const job = f.jobs.get(jobIdFor('larga', 'u1'));
  const progress = [];
  job.updateProgress = async p => { progress.push(p); job.progress = p; };
  await f.service.processMediaJob(job);
  assert.equal(saved.length, 1);
  assert.equal(cleared, 1, 'checkpoints are removed once the transcript is durable');
  assert.ok(progress.some(p => p.completed === 1 && p.total === 2));
  assert.equal(f.rows.get('larga').processingStage, 'ready');
  const read = await f.service.readMediaProgress({ fileIds: ['larga', 'otro'], userId: 'u1' });
  assert.equal(read.larga.completed, 1);
  assert.equal(read.otro, undefined);
  assert.deepEqual(await f.service.readMediaProgress({ fileIds: ['larga'], userId: 'u2' }), {}, 'another user never sees the job');
});

test('a deploy parks the running job without spending a retry (DelayedError) so it resumes from checkpoints', async () => {
  const { DelayedError } = require('bullmq');
  let release;
  const f = fixture([row('clase')], {
    processFile: (file, { signal }) => new Promise((resolve, reject) => {
      release = () => {};
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await f.service.enqueueMediaTranscription({ fileId: 'clase', userId: 'u1' });
  const job = f.jobs.get(jobIdFor('clase', 'u1'));
  const delayed = [];
  job.moveToDelayed = async (ts, token) => { delayed.push({ ts, token }); };
  const running = f.service.processMediaJob(job, 'lock-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.service.abortActive(), 1);
  await assert.rejects(running, err => err instanceof DelayedError);
  assert.equal(delayed.length, 1);
  assert.equal(delayed[0].token, 'lock-token');
  assert.equal(job.attemptsMade, 0);
  assert.equal(f.rows.get('clase').processingStage, 'uploaded', 'chip keeps showing the pending transcription');
  assert.ok(release);
});
