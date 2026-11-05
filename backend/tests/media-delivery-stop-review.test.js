'use strict';

// «Detener» on background transcriptions, after the adversarial review of
// infosiragpt-ops/SiraGPT-APP#1134. Each test is one defect it found:
// Stop reaches both deliveries of a two-link turn, stops the analysis in
// flight, settles a chat whose line was never posted, stops a refine,
// survives a restart in the middle, leaves a recording that had already
// failed alone, and a follow-up that changes nothing adds no analysis.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createMediaDeliveryService, amendedMessage } = require('../src/services/media-delivery');
const { createMediaDeliveryStore } = require('../src/services/media-delivery-store');
const { createMediaTranscriptionService, jobIdFor, refineJobIdFor, CANCELLED_NOTE, RETRYING_PARTIAL } = require('../src/services/media-transcription-queue');

const T0 = Date.parse('2026-11-05T10:00:00Z');
const ENABLED = { SIRAGPT_MEDIA_DELIVERY: '1' };
const TRANSCRIPT = 'Buenos días a todos. Hoy hablamos de la mitocondria.';

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-delivery-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fileRow(id, extra = {}) {
  return { id, userId: 'u1', originalName: `${id}.mp4`, filename: `${id}.mp4`, mimeType: 'video/mp4',
    processingStage: 'extracting', processingError: null, extractedText: null, deletedAt: null, ...extra };
}

async function harness(t, { files = [], overrides = {} } = {}) {
  const root = await tempRoot(t);
  const state = { files: new Map(files.map(row => [row.id, { ...row }])), chats: new Set(['chat1']), messages: [], stopped: [] };
  const metadataFilters = where => [where.metadata, ...(Array.isArray(where.AND) ? where.AND.map(clause => clause.metadata) : [])]
    .filter(Boolean);
  const prisma = { message: { async findFirst({ where }) {
    const filters = metadataFilters(where);
    const found = state.messages.find(m => m.chatId === where.chatId && filters.every(filter => m.metadata?.[filter.path[0]] === filter.equals));
    return found ? { id: found.id, chatId: found.chatId } : null;
  } } };
  const store = createMediaDeliveryStore({ root, now: () => T0 });
  const service = createMediaDeliveryService({
    env: ENABLED, now: Date.now, prisma, store, logger: { info() {}, warn() {} },
    loadFiles: async (userId, ids) => ids.map(id => state.files.get(id)).filter(row => row && row.userId === userId).map(row => ({ ...row })),
    loadTranscript: async () => null,
    readJobStates: async ({ fileIds }) => Object.fromEntries(fileIds.map(id => [id, 'active'])),
    buildArtifacts: async () => [{ filename: 'clase.txt', base64: Buffer.from(TRANSCRIPT).toString('base64'), mime: 'text/plain' }],
    saveArtifact: ({ filename, mime }) => ({ id: `art_${filename}`, filename, format: 'txt', mime, downloadUrl: '/x' }),
    persistArtifact: async () => {},
    postMessage: async ({ userId, chatId, content, metadata }) => {
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    ensureChat: async ({ chatId }) => ({ chatId, created: false }),
    notify: async () => {},
    cancelMediaJobs: async (args) => { state.stopped.push(args); return { stopped: (args.fileIds || []).length + (args.refines || []).length }; },
    recordHints: async () => ({ ok: true }),
    analyze: null,
    ...overrides,
  });
  return { service, state, store };
}

function request(extra = {}) {
  return { userId: 'u1', chatId: 'chat1', taskId: 'task1', fileIds: ['a'], fileNames: ['a.mp4'],
    goal: 'transcribir', mode: 'transcript', formats: ['txt'], ...extra };
}

test('Stop reaches both deliveries of a two-link turn: the hand-off names only the first', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b'), fileRow('c')] });
  // Link deliveries may carry no task id; the hand-off lists both recordings.
  const first = await service.createDelivery(request({ taskId: null, fileIds: ['a'], fileNames: ['a.mp4'] }));
  const second = await service.createDelivery(request({ taskId: null, fileIds: ['b'], fileNames: ['b.mp4'] }));
  const unrelated = await service.createDelivery(request({ taskId: 'task9', fileIds: ['c'], fileNames: ['c.mp4'] }));
  const out = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [first.id], fileIds: ['a', 'b'] });
  assert.equal(out.cancelled, 2);
  assert.equal((await store.get(first.id)).status, 'cancelled');
  assert.equal((await store.get(second.id)).status, 'cancelled', 'the second link stops too');
  assert.equal((await store.get(unrelated.id)).status, 'pending', 'another request of the chat keeps going');
  assert.deepEqual(state.messages.map(message => message.metadata.mediaDelivery).sort(), [first.id, second.id].sort(),
    'one line per delivery: each settles its own recording');
  // A tab on an older bundle sends the id alone: the same task still reaches both.
  const { service: older, store: olderStore } = await harness(t, { files: [fileRow('a'), fileRow('b')] });
  const d1 = await older.createDelivery(request({ fileIds: ['a'], fileNames: ['a.mp4'] }));
  const d2 = await older.createDelivery(request({ fileIds: ['b'], fileNames: ['b.mp4'] }));
  assert.equal((await older.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [d1.id] })).cancelled, 2);
  assert.equal((await olderStore.get(d2.id)).status, 'cancelled');
});

test('Stop during the analysis stops its calls at once and closes the delivery as cancelled', async (t) => {
  let chunks = 0;
  let sawSignal = false;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const { service, state, store } = await harness(t, {
    files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })],
    overrides: {
      analyze: async ({ signal }) => {
        sawSignal = Boolean(signal);
        started();
        // 400 paid chunk calls, as a long batch's translation would make.
        for (let i = 0; i < 400; i++) {
          signal?.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 10));
          chunks += 1;
        }
        return 'resumen';
      },
    },
  });
  const record = await service.createDelivery(request({ mode: 'analysis', goal: 'resúmelo' }));
  const delivering = service.deliverOne(record.id);
  await running;
  const out = await service.cancelDelivery(record.id, { userId: 'u1' });
  const result = await delivering;
  assert.equal(sawSignal, true, 'the analysis hears the Stop');
  assert.ok(chunks < 400, `the calls stop at once (${chunks} of 400 ran)`);
  assert.equal(result.status, 'cancelled');
  assert.equal(out.outcome, 'cancelled');
  assert.equal((await store.get(record.id)).status, 'cancelled');
  assert.equal(state.messages.length, 1, 'only the line that settles the turn');
  assert.equal(state.messages[0].metadata.deliveryKind, 'cancelled');
});

test('a Stop whose line was never posted is settled by the next Stop; a delivery that failed without a line too', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b')] });
  const record = await service.createDelivery(request());
  // The first Stop closed it, but its line never reached the chat (a DB blip).
  await store.cancel(record.id, { userId: 'u1' });
  assert.equal(state.messages.length, 0);
  const out = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] });
  assert.equal(out.cancelled, 1, 'reported as stopped now that the chat says so');
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].metadata.mediaDelivery, record.id);
  assert.equal(state.messages[0].metadata.deliveryKind, 'cancelled');
  assert.ok(state.stopped.some(args => (args.fileIds || []).includes('a')), 'its recordings stop too');
  // A third Stop posts nothing more.
  await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] });
  assert.equal(state.messages.length, 1);

  // A delivery that failed before failures left a line: Stop settles the chat with the failure.
  const failed = await service.createDelivery(request({ fileIds: ['b'], fileNames: ['b.mp4'] }));
  const held = await store.claim(failed.id);
  await store.markFailed(failed.id, held.token, Object.assign(new Error('x'), { code: 'artifact_error' }), { maxAttempts: 1, backoffMs: [0] });
  assert.equal((await store.get(failed.id)).status, 'failed');
  const again = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [failed.id] });
  assert.equal(again.results[0].outcome, 'already_terminal');
  const line = state.messages.find(message => message.metadata.mediaDelivery === failed.id);
  assert.equal(line?.metadata.deliveryKind, 'failed');
});

test('the Stop marker is written before the chat line: a restart in between leaves a Stop, never an open request', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a')] });
  const record = await service.createDelivery(request());
  let markerFirst = null;
  await store.cancel(record.id, { userId: 'u1', beforeClose: async () => {
    markerFirst = await store.isCancelRequested(record.id);
    return null;
  } });
  assert.equal(markerFirst, true, 'the marker exists while the line is posted');

  // What a process that died right after the line leaves: an open record,
  // its marker and its line in the chat.
  const open = await service.createDelivery(request());
  const held = await store.claim(open.id);
  assert.equal((await store.cancel(open.id, { userId: 'u1', tries: 1, waitMs: 1 })).outcome, 'cancel_requested');
  await store.release(open.id, held.token);
  state.messages.push({ id: 'note1', chatId: 'chat1', content: 'Detuve la transcripción de «a.mp4».',
    metadata: { source: 'media-delivery', mediaDelivery: open.id, transcriptionFileIds: ['a'], deliveryKind: 'cancelled' } });
  assert.equal((await store.get(open.id)).status, 'pending');
  // A follow-up after the restart is not taken: the request is stopped.
  assert.equal((await store.amend(open.id, { userId: 'u1', amendment: { goal: 'y tradúcelo', translationTarget: 'en' } })).outcome, 'cancelled');
  // The next sweep finishes the Stop: closed, its jobs stopped, no second line.
  const run = await service.deliverOne(open.id);
  assert.equal(run.status, 'cancelled');
  assert.equal((await store.get(open.id)).status, 'cancelled');
  assert.equal(state.messages.filter(message => message.metadata.mediaDelivery === open.id).length, 1);
  assert.ok(state.stopped.some(args => (args.fileIds || []).includes('a')));
});

test('Stop on a refine stops the refine job with it', async (t) => {
  const { service, state } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const record = await service.createDelivery(request({ kind: 'refine', range: { start: 720, end: 900 }, language: 'en', hints: null }));
  const out = await service.cancelDelivery(record.id, { userId: 'u1' });
  assert.equal(out.outcome, 'cancelled');
  const call = state.stopped.find(args => Array.isArray(args.refines) && args.refines.length);
  assert.ok(call, 'the refine reaches the queue');
  assert.deepEqual(call.refines[0], { fileId: 'a', range: { start: 720, end: 900 }, language: 'en', hints: null, deliveryId: record.id });
});

test('a Catalan follow-up is confirmed with the language name', () => {
  assert.match(amendedMessage({ changes: ['translation'], record: { fileIds: ['a'], output: { translationTarget: 'ca' } } }), /traducida al catalán/);
});

// ── the media queue ─────────────────────────────────────────────────────

function queueHarness({ rows, jobs = {}, honourNot = false } = {}) {
  const files = new Map(rows.map(row => [row.id, { ...row }]));
  const excluded = (row, where) => honourNot && where.NOT && Object.entries(where.NOT).every(([key, value]) => row[key] === value);
  const prisma = { file: {
    async findFirst({ where }) { const row = files.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null; },
    async updateMany({ where, data }) {
      const row = files.get(where.id);
      if (!row || row.userId !== where.userId || row.deletedAt || excluded(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  } };
  const removed = [];
  const added = [];
  const queue = {
    async getJob(jobId) {
      const job = jobs[jobId];
      if (!job) return null;
      return { id: jobId, ...job, getState: async () => job.state, remove: async () => { removed.push(jobId); delete jobs[jobId]; } };
    },
    async add(name, data, opts) { added.push({ name, data, jobId: opts.jobId }); jobs[opts.jobId] = { state: 'waiting', data }; return {}; },
  };
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue, processFile: async () => ({}), logger: { info() {}, warn() {} } });
  return { service, files, removed, added, jobs };
}

test('Stop leaves a recording that had already failed alone: its reason stays and it is not re-queued', async () => {
  const drm = 'Este archivo está protegido contra copia (DRM) y no se puede transcribir.';
  const { service, files } = queueHarness({ rows: [fileRow('c', { processingStage: 'failed', processingError: drm })] });
  const out = await service.cancelMediaTranscription({ fileIds: ['c'], userId: 'u1' });
  assert.deepEqual(out.results, [{ id: 'c', outcome: 'failed' }]);
  assert.equal(out.stopped, 0);
  assert.equal(files.get('c').processingError, drm);
});

test('a refine stopped with its delivery: the queued job goes; the transcript stays', async () => {
  const range = { start: 720, end: 900 };
  const media = { language: 'en' };
  const { requestMedia } = require('../src/services/media-transcription-queue');
  const id = refineJobIdFor('a', 'u1', range, requestMedia(media, T0));
  const { service, files, removed } = queueHarness({ rows: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })],
    jobs: { [id]: { state: 'delayed', data: { refine: true, deliveryId: 'd1' } } } });
  const out = await service.cancelMediaTranscription({ fileIds: ['a'], userId: 'u1', refines: [{ fileId: 'a', range, language: 'en', hints: null, deliveryId: 'd1' }] });
  assert.deepEqual(removed, [id]);
  assert.equal(out.results.find(result => result.refine).outcome, 'removed');
  assert.equal(files.get('a').processingStage, 'ready');
  assert.equal(files.get('a').extractedText, TRANSCRIPT);
});

test('a refine running while a gap retry waits: Stop settles the row, so recovery never re-queues the retry', async () => {
  // The running refine is simulated by its job context: abort it and check the row.
  const rows = new Map([['a', fileRow('a', { processingStage: 'uploaded', extractedText: TRANSCRIPT, processingError: RETRYING_PARTIAL, path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null; },
    async updateMany({ where, data }) { const row = rows.get(where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  const jobs = new Map();
  const queue = { async getJob(jobId) { return jobs.get(jobId) || null; }, async add() { return {}; } };
  jobs.set(jobIdFor('a', 'u1'), { id: jobIdFor('a', 'u1'), getState: async () => 'delayed', remove: async () => { jobs.delete(jobIdFor('a', 'u1')); } });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  // A refine is running on the file: hold it in its engine call until the abort.
  rows.get('a').processingStage = 'ready';
  rows.get('a').processingError = null;
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue, now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }),
    logger: { info() {}, warn() {} },
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
  });
  const refine = service.processMediaJob({ data: { fileId: 'a', userId: 'u1', refine: true, range: { start: 0, end: 60 }, deliveryId: 'd1' }, opts: { attempts: 1 }, attemptsMade: 0 });
  await ready;
  // Meanwhile «reintenta» queued a gap retry behind it.
  rows.get('a').processingStage = 'uploaded';
  rows.get('a').processingError = RETRYING_PARTIAL;
  const out = await service.cancelMediaTranscription({ fileIds: ['a'], userId: 'u1' });
  await assert.rejects(refine);
  assert.equal(out.results[0].outcome, 'removed');
  assert.equal(rows.get('a').processingStage, 'ready', 'the partial transcript is back, not left pending');
  assert.match(rows.get('a').processingError, /^Parcial:/);
  assert.ok(!jobs.has(jobIdFor('a', 'u1')), 'the parked gap retry is gone');
});

test('asked again after Stop, a stopped job that survived is replaced and the recording transcribes', async () => {
  const { service, files, removed, added } = queueHarness({
    rows: [fileRow('a', { processingStage: 'failed', processingError: CANCELLED_NOTE, mimeType: 'audio/mpeg' })],
    jobs: { [jobIdFor('a', 'u1')]: { state: 'waiting', data: { fileId: 'a', userId: 'u1' } } },
  });
  const out = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1', retry: true });
  assert.equal(out.queued, true);
  assert.deepEqual(removed, [jobIdFor('a', 'u1')]);
  assert.equal(added.length, 1, 'a fresh job');
  assert.equal(files.get('a').processingStage, 'uploaded');
  assert.equal(files.get('a').processingError, null, 'the stop note is cleared');
});

test('a retry or a deploy park on another worker never erases a Stop', async () => {
  const { service, files } = queueHarness({
    rows: [fileRow('a', { processingStage: 'extracting', path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })], honourNot: true,
  });
  // The other process's Stop lands while this worker's job fails transiently.
  const job = { data: { fileId: 'a', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0, discard() {} };
  const failing = createMediaTranscriptionService({
    prisma: { file: {
      findFirst: async ({ where }) => { const row = files.get(where.id); return row ? { ...row } : null; },
      updateMany: async (args) => {
        const row = files.get(args.where.id);
        if (args.where.NOT && Object.entries(args.where.NOT).every(([key, value]) => row[key] === value)) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    } },
    getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }), logger: { info() {}, warn() {} },
    processFile: async () => {
      files.get('a').processingStage = 'failed';
      files.get('a').processingError = CANCELLED_NOTE;
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
  });
  await assert.rejects(failing.processMediaJob(job), { code: 'ETIMEDOUT' });
  assert.equal(files.get('a').processingError, CANCELLED_NOTE, 'the next attempt reads the stop note and ends');
  assert.equal(files.get('a').processingStage, 'failed');
  void service;
});

test('a follow-up the rules read and that was already so adds no analysis', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'agent-task-runner.js'), 'utf8');
  const branch = source.slice(source.indexOf("let amended = await pendingService.amendDelivery("), source.indexOf("if (amended?.outcome === 'amended' || amended?.outcome === 'unchanged')"));
  assert.match(branch, /const recognised = Boolean\(amendment\.translationTarget \|\| amendment\.removeTranslation \|\| amendment\.removeAnalysis/);
  assert.match(branch, /amended\?\.outcome === 'unchanged' && !recognised && !plainTranscriptionRequest/);
});
