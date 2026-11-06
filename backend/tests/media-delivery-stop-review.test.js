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

test('a Stop the holder honoured mid-analysis whose line fails is still reported as a Stop; the next press posts it', async (t) => {
  let down = true;
  const { service, state, store } = await harness(t, { files: [fileRow('a')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    } } });
  const record = await service.createDelivery(request());
  // The holder (analysing a 10-hour translation) honoured the Stop and closed it: no line yet.
  const held = await store.claim(record.id);
  await store.markCancelled(record.id, held.token);
  assert.equal((await store.get(record.id)).status, 'cancelled');
  const first = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] });
  assert.equal(first.results[0].outcome, 'cancel_requested');
  assert.equal(first.cancelled, 1, 'reported as stopped, never «ya había terminado» (which hides Stop)');
  assert.equal(state.messages.length, 0);
  down = false;
  const second = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] });
  assert.equal(second.results[0].outcome, 'cancelled');
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1);
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

// The where clauses the queue writes with, evaluated like PostgreSQL: a
// `{ not: v }` never matches NULL.
function matchesClause(row, clause) {
  return Object.entries(clause).every(([key, value]) => {
    if (value === null) return row[key] == null;
    if (value && typeof value === 'object' && 'not' in value) return row[key] != null && row[key] !== value.not;
    return row[key] === value;
  });
}
function matchesExtras(row, where) {
  return !Array.isArray(where.OR) || where.OR.some(clause => matchesClause(row, clause));
}

function queueHarness({ rows, jobs = {}, honourNot = false } = {}) {
  const files = new Map(rows.map(row => [row.id, { ...row }]));
  const excluded = (row, where) => honourNot && !matchesExtras(row, where);
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
        if (!matchesExtras(row, args.where)) return { count: 0 };
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
  // The where clause still matches an ordinary row: NULL stage or error.
  assert.equal(matchesExtras({ processingStage: 'extracting', processingError: null }, { OR: [{ processingStage: null }, { processingStage: { not: 'failed' } }, { processingError: null }, { processingError: { not: CANCELLED_NOTE } }] }), true);
  assert.equal(matchesExtras({ processingStage: null, processingError: null }, { OR: [{ processingStage: null }, { processingStage: { not: 'failed' } }, { processingError: null }, { processingError: { not: CANCELLED_NOTE } }] }), true);
  assert.equal(matchesExtras({ processingStage: 'failed', processingError: 'DRM' }, { OR: [{ processingStage: null }, { processingStage: { not: 'failed' } }, { processingError: null }, { processingError: { not: CANCELLED_NOTE } }] }), true);
  assert.equal(matchesExtras({ processingStage: 'failed', processingError: CANCELLED_NOTE }, { OR: [{ processingStage: null }, { processingStage: { not: 'failed' } }, { processingError: null }, { processingError: { not: CANCELLED_NOTE } }] }), false);
});

test('a transient retry on an ordinary row still resets it for the next attempt', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'extracting', path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  const service = createMediaTranscriptionService({
    prisma: { file: {
      findFirst: async ({ where }) => { const row = rows.get(where.id); return row ? { ...row } : null; },
      updateMany: async (args) => { const row = rows.get(args.where.id); if (!matchesExtras(row, args.where)) return { count: 0 }; Object.assign(row, args.data); return { count: 1 }; },
    } },
    getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }), logger: { info() {}, warn() {} },
    processFile: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  });
  const job = { data: { fileId: 'a', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0, discard() {} };
  await assert.rejects(service.processMediaJob(job), { code: 'ETIMEDOUT' });
  assert.equal(rows.get('a').processingStage, 'uploaded');
  assert.equal(rows.get('a').processingError, null);
});

test('a follow-up the rules read and that was already so adds no analysis', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'agents', 'agent-task-runner.js'), 'utf8');
  const branch = source.slice(source.indexOf("let amended = await pendingService.amendDelivery("), source.indexOf("if (amended?.outcome === 'amended' || amended?.outcome === 'unchanged')"));
  assert.match(branch, /const recognised = Boolean\(amendment\.translationTarget \|\| amendment\.removeTranslation \|\| amendment\.removeAnalysis/);
  assert.match(branch, /amended\?\.outcome === 'unchanged' && !recognised && !plainTranscriptionRequest/);
  // Names or a language from earlier turns say nothing about this message.
  assert.match(branch, /mediaBatch\.extractTranscriptionHints\(mediaGoal, \[\]\)/);
  assert.doesNotMatch(branch.slice(branch.indexOf('const recognised')), /amendment\.language|amendment\.hints/);
  const mediaBatch = require('../src/services/media-batch');
  const own = goal => mediaBatch.hintsForJob(mediaBatch.extractTranscriptionHints(goal, []));
  assert.deepEqual(own('solo lo que dice el profesor'), { language: null, hints: null }, 'an unnamed instruction says no hint');
  assert.equal(own('está en inglés').language, 'en');
});

// ── the second round: follow-ups after the runner and frontend review ─────

test('two questions about two moments read both windows; a question with no window reads the whole recording', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord(request({ fileIds: ['a'], fileNames: ['a.mp4'] }), T0);
  const first = mergeDeliveryAmendment(record, { goal: '¿qué dijo en el minuto 30?', wantsAnalysis: true, analysisRange: { start: 1740, end: 2040 } }).record;
  assert.deepEqual(first.output.analysisRange, { start: 1740, end: 2040 });
  const second = mergeDeliveryAmendment(first, { goal: '¿y en el minuto 50?', wantsAnalysis: true, analysisRange: { start: 2940, end: 3240 } });
  assert.deepEqual(second.record.output.analysisRange, { start: 1740, end: 3240 }, 'their span, never only the latest');
  const whole = mergeDeliveryAmendment(second.record, { goal: '¿y quién es el profesor?', wantsAnalysis: true });
  assert.equal(whole.record.output.analysisRange, undefined);
  assert.ok(whole.changes.includes('analysis_range'));
});

test('a translation of a moment is stored apart: the transcript keeps its whole range', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord, normalizeOutput } = require('../src/services/media-delivery-store');
  const record = normalizeNewRecord(request(), T0);
  const { record: next, changes } = mergeDeliveryAmendment(record, { goal: 'traduce al inglés lo que dice en el minuto 30', translationTarget: 'en',
    translationRange: { start: 1740, end: 2040 } });
  assert.ok(changes.includes('translation'));
  assert.ok(changes.includes('translation_range'));
  assert.deepEqual(next.output.translationRange, { start: 1740, end: 2040 });
  assert.equal(next.range, null, 'the transcript files are not cut');
  if (typeof normalizeOutput === 'function') assert.deepEqual(normalizeOutput(next.output).translationRange, { start: 1740, end: 2040 });
  assert.match(amendedMessage({ changes, record: next }), /traducida al inglés \(la traducción, solo del tramo que indicaste\)/);
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'services', 'media-delivery.js'), 'utf8');
  assert.match(source, /const range = translationRangeOf\(delivery\) \|\| rangeOf\(delivery\);/, 'the translation reads that window, over the transcript\'s range');
});

test('a turned-down format goes; the model changes only for model work', () => {
  const { mergeDeliveryAmendment, normalizeNewRecord } = require('../src/services/media-delivery-store');
  const pro = { id: 'deepseek-v4-pro', provider: 'DeepSeek' };
  const flash = { id: 'deepseek-v4-flash', provider: 'DeepSeek' };
  const record = normalizeNewRecord(request({ mode: 'analysis', model: pro, formats: ['txt', 'docx', 'srt', 'vtt'],
    output: { documentFormat: 'docx', wantsSubtitles: true } }), T0);
  const word = mergeDeliveryAmendment(record, { goal: 'no lo quiero en Word', removeDocument: ['docx'], model: flash });
  assert.ok(word.changes.includes('no_document'));
  assert.equal(word.record.output.documentFormat, undefined);
  assert.ok(!word.record.formats.includes('docx'));
  assert.deepEqual(word.record.model, pro, 'the summary Pro was asked to write stays with Pro');
  assert.match(amendedMessage({ changes: word.changes, record: word.record }), /sin el documento que habías pedido/);
  const subs = mergeDeliveryAmendment(record, { goal: 'sin subtítulos', removeSubtitles: true, model: flash });
  assert.ok(subs.changes.includes('no_subtitles'));
  assert.equal(subs.record.output.wantsSubtitles, false);
  assert.ok(!subs.record.formats.includes('srt') && !subs.record.formats.includes('vtt'));
  const names = mergeDeliveryAmendment(record, { goal: 'los nombres son Huamán y Quispe', hints: { terms: ['Huamán', 'Quispe'] }, model: flash });
  assert.deepEqual(names.record.model, pro);
  const ask = mergeDeliveryAmendment(record, { goal: 'y tradúcelo al inglés', translationTarget: 'en', model: flash });
  assert.deepEqual(ask.record.model, flash, 'new model work runs on the model picked for it');
});

test('a Stop the store cannot record answers 500 and still stops the jobs', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a')] });
  const record = await service.createDelivery(request());
  store.cancel = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const out = await service.cancelDelivery(record.id, { userId: 'u1' });
  assert.equal(out.outcome, 'error');
  assert.ok(state.stopped.some(args => (args.fileIds || []).includes('a')), 'the user said stop: the jobs stop');
  const express = require('express');
  const { createMediaDeliveriesRouter } = require('../src/routes/media-deliveries');
  const app = express();
  app.use(express.json());
  app.use('/api/media-deliveries', createMediaDeliveriesRouter({
    delivery: { cancelChatDeliveries: async () => ({ cancelled: 0, results: [{ id: record.id, outcome: 'error' }] }) },
    auth: (req, _res, next) => { req.user = { id: 'u1' }; next(); } }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/media-deliveries/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: 'chat1' }) });
    assert.equal(res.status, 500, 'never «ya había terminado»');
    assert.equal((await res.json()).code, 'cancel_failed');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ── the third round: who may stop what, and a Stop that survives faults ───

test('a Stop from another account never touches a delivery this process is delivering', async (t) => {
  let chunks = 0;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const { service, state, store } = await harness(t, {
    files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })],
    overrides: {
      analyze: async ({ signal }) => {
        started();
        for (let i = 0; i < 40; i++) {
          signal?.throwIfAborted();
          await new Promise(resolve => setTimeout(resolve, 5));
          chunks += 1;
        }
        return 'resumen';
      },
    },
  });
  const record = await service.createDelivery(request({ mode: 'analysis', goal: 'resúmelo' }));
  const delivering = service.deliverOne(record.id);
  await running;
  // Its hand-off was copied into another account's chat (a saved share).
  const out = await service.cancelChatDeliveries({ userId: 'u2', chatId: 'chat2', deliveryIds: [record.id], fileIds: ['a'] });
  assert.deepEqual(out.results.map(result => result.outcome), ['missing']);
  assert.equal(out.cancelled, 0);
  const result = await delivering;
  assert.equal(result.status, 'delivered', 'the owner still gets the result');
  assert.equal(chunks, 40, 'its analysis ran to the end');
  assert.equal((await store.get(record.id)).status, 'delivered');
  assert.equal(state.stopped.length, 0, 'no job of the owner stopped');
  assert.ok(state.messages.every(message => message.chatId === 'chat1' && message.metadata.deliveryKind !== 'cancelled'));
  // Even called with the delivery id alone, another account cannot stop it.
  const again = await service.createDelivery(request());
  assert.equal((await service.cancelDelivery(again.id, { userId: 'u2' })).outcome, 'missing');
  assert.equal((await store.get(again.id)).status, 'pending');
});

test('Stop in a branch of the chat never stops the original chat\'s transcription', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a')] });
  const record = await service.createDelivery(request());
  // The branch copied the hand-off (an older bundle, before copies were marked).
  const out = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'branch1', deliveryIds: [record.id], fileIds: ['a'] });
  assert.deepEqual(out.results.map(result => result.outcome), ['missing']);
  assert.equal(out.cancelled, 0);
  assert.equal((await store.get(record.id)).status, 'pending', 'the original request keeps going');
  assert.equal(state.messages.length, 0, 'nothing posted into the original chat');
  assert.equal(state.stopped.length, 0);
  // The same Stop in the chat that asked for it stops it.
  assert.equal((await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] })).cancelled, 1);
});

test('a Stop line that cannot be posted keeps the request open: the next Stop or the sweep posts it', async (t) => {
  let down = true;
  const posted = [];
  const { service, state, store } = await harness(t, {
    files: [fileRow('a'), fileRow('b')],
    overrides: {
      postMessage: async ({ userId, chatId, content, metadata }) => {
        if (down && metadata.mediaDelivery === secondId) throw Object.assign(new Error('db'), { code: 'P1001' });
        const message = { id: `msg${posted.length + 1}`, userId, chatId, content, metadata };
        posted.push(message);
        state.messages.push(message);
        return { messageId: message.id, chatId };
      },
    },
  });
  // Two links handed off in one turn: the hand-off names only the first.
  const first = await service.createDelivery(request({ taskId: null, fileIds: ['a'], fileNames: ['a.mp4'] }));
  const second = await service.createDelivery(request({ taskId: null, fileIds: ['b'], fileNames: ['b.mp4'] }));
  var secondId = second.id; // eslint-disable-line no-var
  const out = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [first.id], fileIds: ['a', 'b'] });
  assert.equal(out.cancelled, 2, 'both are stopped');
  assert.equal((await store.get(first.id)).status, 'cancelled');
  assert.equal((await store.get(second.id)).status, 'pending', 'its line is missing: the request stays open');
  assert.equal(await store.isCancelRequested(second.id), true, 'and stopped');
  assert.ok(state.stopped.some(args => (args.fileIds || []).includes('b')), 'its jobs stop now');
  // A follow-up meanwhile is not taken: the request is stopped.
  assert.equal((await store.amend(second.id, { userId: 'u1', amendment: { goal: 'y tradúcelo', translationTarget: 'en' } })).outcome, 'cancelled');
  // The sweep posts the line once the chat is reachable again, then closes it.
  down = false;
  const run = await service.deliverOne(second.id);
  assert.equal(run.status, 'cancelled');
  assert.equal((await store.get(second.id)).status, 'cancelled');
  assert.equal(posted.filter(message => message.metadata.mediaDelivery === second.id).length, 1);
  assert.equal(posted.find(message => message.metadata.mediaDelivery === second.id).metadata.deliveryKind, 'cancelled');
  // A deleted chat has nothing to settle: that Stop closes at once.
  const gone = await harness(t, { files: [fileRow('c')], overrides: {
    postMessage: async () => { throw Object.assign(new Error('gone'), { code: 'chat_unavailable' }); } } });
  const lone = await gone.service.createDelivery(request({ fileIds: ['c'], fileNames: ['c.mp4'] }));
  assert.equal((await gone.service.cancelDelivery(lone.id, { userId: 'u1' })).outcome, 'cancelled');
  assert.equal((await gone.store.get(lone.id)).status, 'cancelled');
});

test('a Stop stops its jobs once: the sweep that posts its line never stops a recording asked for again since', async (t) => {
  let down = true;
  const { service, state, store } = await harness(t, { files: [fileRow('a')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    } } });
  const record = await service.createDelivery(request());
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  assert.equal(state.stopped.filter(args => (args.fileIds || []).includes('a')).length, 1, 'the jobs stop with the Stop');
  assert.equal((await store.cancelMarker(record.id))?.jobsStopped, true);
  // The user asks for the recording again; its new request is not open yet.
  state.files.get('a').processingStage = 'uploaded';
  down = false;
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled', 'the sweep posts the line and closes it');
  assert.equal(state.stopped.filter(args => (args.fileIds || []).includes('a')).length, 1, 'and stops nothing again');
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1);
  assert.equal(await store.cancelMarker(record.id), null, 'closed: no marker left behind');
  assert.equal(await store.noteJobsStopped(record.id), false, 'never a marker for a closed record');

  // A restart mid-Stop (its lock left behind): the first sweep stops the jobs, the next ones do not.
  const again = await harness(t, { files: [fileRow('b', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const held = await again.service.createDelivery(request({ fileIds: ['b'], fileNames: ['b.mp4'] }));
  await again.store.claim(held.id);
  assert.equal((await again.store.cancel(held.id, { userId: 'u1', tries: 1, waitMs: 1 })).outcome, 'cancel_requested');
  assert.equal((await again.service.deliverOne(held.id)).status, 'cancelling');
  assert.equal((await again.service.deliverOne(held.id)).status, 'cancelling');
  assert.equal(again.state.stopped.filter(args => (args.fileIds || []).includes('b')).length, 1);
});

test('a Stop line that keeps failing closes the request after the retry window', async (t) => {
  const root = await tempRoot(t);
  let clock = T0;
  const store = createMediaDeliveryStore({ root, now: () => clock, cancelSettleRetryMs: 60_000 });
  const record = await store.create(request());
  const failing = async () => ({ error: 'P1001' });
  assert.equal((await store.cancel(record.id, { userId: 'u1', beforeClose: failing })).outcome, 'cancel_requested');
  clock += 30_000;
  assert.equal((await store.cancel(record.id, { userId: 'u1', beforeClose: failing })).outcome, 'cancel_requested',
    'a repeated Stop keeps the first time');
  clock += 31_000;
  const closed = await store.cancel(record.id, { userId: 'u1', beforeClose: failing });
  assert.equal(closed.outcome, 'cancelled');
  assert.equal((await store.get(record.id)).status, 'cancelled');
  assert.equal((await store.get(record.id)).cancelledAt, new Date(T0).toISOString(), 'stamped with the Stop itself');
});

test('a restart in the middle of a Stop leaves its lock: the sweep still stops the jobs, nothing is delivered', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const record = await service.createDelivery(request());
  // The process that pressed Stop died holding the lock, after the marker.
  await store.claim(record.id);
  assert.equal((await store.cancel(record.id, { userId: 'u1', tries: 1, waitMs: 1 })).outcome, 'cancel_requested');
  const run = await service.deliverOne(record.id);
  assert.equal(run.status, 'cancelling');
  assert.ok(state.stopped.some(args => (args.fileIds || []).includes('a')), 'the jobs stop: no more billing');
  assert.equal(state.messages.length, 0, 'no transcript is posted after the Stop');
  assert.notEqual((await store.get(record.id)).status, 'delivered');
});

test('a refine stopped with its request does not run later, unless another open request wants the same window', async (t) => {
  const { service, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const refine = { kind: 'refine', range: { start: 720, end: 900 }, language: 'en', hints: null };
  const stopped = await service.createDelivery(request(refine));
  assert.equal(await service.isRefineJobWanted({ deliveryId: stopped.id, fileId: 'a', userId: 'u1' }), true);
  await service.cancelDelivery(stopped.id, { userId: 'u1' });
  assert.equal((await store.get(stopped.id)).status, 'cancelled');
  assert.equal(await service.isRefineJobWanted({ deliveryId: stopped.id, fileId: 'a', userId: 'u1' }), false);
  // The same window asked again in another request shares the job: it runs.
  const twin = await service.createDelivery(request({ ...refine, taskId: 'task2' }));
  assert.equal(await service.isRefineJobWanted({ deliveryId: stopped.id, fileId: 'a', userId: 'u1' }), true);
  await service.cancelDelivery(twin.id, { userId: 'u1' });
  // Another window does not.
  await service.createDelivery(request({ ...refine, taskId: 'task3', range: { start: 0, end: 60 } }));
  assert.equal(await service.isRefineJobWanted({ deliveryId: stopped.id, fileId: 'a', userId: 'u1' }), false);
  // Unknown or someone else's: the job runs.
  assert.equal(await service.isRefineJobWanted({ deliveryId: 'md_unknown', fileId: 'a', userId: 'u1' }), true);
  assert.equal(await service.isRefineJobWanted({ deliveryId: stopped.id, fileId: 'a', userId: 'u2' }), true);
});

test('Stop of a refine in one chat leaves the job another chat\'s open refine of the same window shares', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const refine = { kind: 'refine', range: { start: 720, end: 900 }, language: 'en', hints: null };
  const first = await service.createDelivery(request({ ...refine, chatId: 'chat1' }));
  const branch = await service.createDelivery(request({ ...refine, chatId: 'chat2', taskId: 'task2' }));
  const refinesStopped = () => state.stopped.flatMap(args => args.refines || []);
  await service.cancelDelivery(first.id, { userId: 'u1' });
  assert.equal((await store.get(first.id)).status, 'cancelled');
  assert.deepEqual(refinesStopped(), [], 'chat2 still waits on the same job');
  assert.equal(await service.isRefineJobWanted({ deliveryId: first.id, fileId: 'a', userId: 'u1' }), true);
  await service.cancelDelivery(branch.id, { userId: 'u1' });
  assert.deepEqual(refinesStopped().map(spec => spec.deliveryId), [branch.id], 'the last one stops it');

  // A twin stopped too (its line still to post) wants nothing: the job goes.
  let down = true;
  const other = await harness(t, { files: [fileRow('b', { processingStage: 'ready', extractedText: TRANSCRIPT })], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      other.state.messages.push({ id: `m${other.state.messages.length + 1}`, userId, chatId, content, metadata });
      return { messageId: `m${other.state.messages.length}`, chatId };
    } } });
  const one = await other.service.createDelivery(request({ ...refine, chatId: 'chat1', fileIds: ['b'], fileNames: ['b.mp4'] }));
  const two = await other.service.createDelivery(request({ ...refine, chatId: 'chat2', taskId: 'task2', fileIds: ['b'], fileNames: ['b.mp4'] }));
  assert.equal((await other.service.cancelDelivery(two.id, { userId: 'u1' })).outcome, 'cancel_requested');
  down = false;
  await other.service.cancelDelivery(one.id, { userId: 'u1' });
  assert.ok(other.state.stopped.flatMap(args => args.refines || []).some(spec => spec.deliveryId === one.id));
  assert.equal(await other.service.isRefineJobWanted({ deliveryId: one.id, fileId: 'b', userId: 'u1' }), false);
});

test('the worker\'s failed handler never writes the Stop note over a recording asked for again', async () => {
  const dbPath = require.resolve('../src/config/database');
  const previous = require.cache[dbPath];
  const rows = new Map([['a', fileRow('a', { processingStage: 'uploaded', processingError: null })],
    ['b', fileRow('b', { processingStage: 'extracting', processingError: null })]]);
  const writes = [];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { file: {
    findFirst: async ({ where }) => ({ ...rows.get(where.id) }),
    updateMany: async ({ where, data }) => { writes.push([where.id, data]); return { count: 1 }; },
  } } };
  const { onWorkerFailed } = require('../src/services/media-transcription-queue');
  const job = fileId => ({ data: { fileId, userId: 'u1' }, getState: async () => 'failed' });
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  try {
    onWorkerFailed(job('a'), Object.assign(new Error(CANCELLED_NOTE), { code: 'media_cancelled' }));
    await settle();
    assert.deepEqual(writes, [], 'the row asked for again stays as it is');
    // Any other terminal failure still persists, so a chip never shows «extrayendo» forever.
    onWorkerFailed(job('b'), Object.assign(new Error('boom'), { code: 'provider_error' }));
    await settle();
    assert.deepEqual(writes.map(([id, data]) => [id, data.processingStage]), [['b', 'failed']]);
  } finally {
    if (previous) require.cache[dbPath] = previous; else delete require.cache[dbPath];
  }
});

// The ownership check runs on an unref'd interval: a test waiting on it keeps
// the event loop alive with a timer of its own, bounded.
async function settledWithin(promise, ms = 3000) {
  let timer;
  const limit = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  try {
    return await Promise.race([promise.then(value => ({ value }), error => ({ error })), limit]);
  } finally {
    clearTimeout(timer);
  }
}

function refineQueue({ isRefineWanted, ownershipCheckMs = 0, onEngine = null }) {
  const rows = new Map([['a', fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT, path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null; },
    async updateMany({ where, data }) { const row = rows.get(where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  let materialized = 0;
  const service = createMediaTranscriptionService({ prisma, getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async (source) => { materialized += 1; return { path: source, cleanup: async () => {} }; },
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }),
    logger: { info() {}, warn() {} }, ownershipCheckMs, isRefineWanted,
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => {
      onEngine?.();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const job = { data: { fileId: 'a', userId: 'u1', refine: true, range: { start: 0, end: 60 }, deliveryId: 'md_stopped' }, opts: { attempts: 1 }, attemptsMade: 0, discard() {} };
  return { service, rows, job, materialized: () => materialized };
}

test('a refine job that survived a Stop ends before any provider call; one already running stops at its next check', async () => {
  const queued = refineQueue({ isRefineWanted: async () => false });
  const first = await settledWithin(queued.service.processMediaJob(queued.job), 1000);
  queued.service.abortActive();
  assert.equal(first.error?.code, 'media_cancelled');
  assert.equal(queued.materialized(), 0, 'nothing downloaded, nothing sent to a provider');
  assert.equal(queued.rows.get('a').extractedText, TRANSCRIPT, 'the transcript is untouched');
  assert.equal(queued.rows.get('a').processingStage, 'ready');
  // Running on another worker when the Stop lands: its periodic check ends it.
  let wanted = true;
  let engine;
  const inEngine = new Promise(resolve => { engine = resolve; });
  const live = refineQueue({ isRefineWanted: async () => wanted, ownershipCheckMs: 20, onEngine: () => engine() });
  const running = live.service.processMediaJob(live.job);
  await inEngine;
  wanted = false;
  const ended = await settledWithin(running);
  assert.equal(ended.error?.code, 'media_cancelled');
  assert.equal(live.rows.get('a').extractedText, TRANSCRIPT);
  assert.equal(live.rows.get('a').processingStage, 'ready');
  // A lookup that fails lets the refine run.
  let reached;
  const reachedEngine = new Promise(resolve => { reached = resolve; });
  const blipRun = refineQueue({ isRefineWanted: async () => { throw new Error('store down'); }, onEngine: () => reached(true) });
  const pending = blipRun.service.processMediaJob(blipRun.job);
  assert.equal((await settledWithin(reachedEngine)).value, true, 'the engine runs when the Stop cannot be read');
  blipRun.service.abortActive();
  assert.ok((await settledWithin(pending)).error);
});

test('asked again after Stop while the stopped job stays active elsewhere: the note is cleared at once, no wait', async () => {
  const { service, files, added } = queueHarness({
    rows: [fileRow('a', { processingStage: 'failed', processingError: CANCELLED_NOTE, mimeType: 'audio/mpeg' })],
    // Stalled after a deploy, or running on another worker: no abort here.
    jobs: { [jobIdFor('a', 'u1')]: { state: 'active', data: { fileId: 'a', userId: 'u1' } } },
  });
  const startedAt = Date.now();
  const out = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1', retry: true });
  assert.ok(Date.now() - startedAt < 1000, 'no 5 s wait per file');
  assert.equal(out.queued, true);
  assert.equal(files.get('a').processingStage, 'uploaded');
  assert.equal(files.get('a').processingError, null, 'the surviving job carries on instead of ending on the note');
  assert.equal(added.length, 0, 'the same job, not a second one');
});

test('a job that ended on a Stop after the recording was asked for again runs again on recovery', async () => {
  let retried = 0;
  const { service, files } = queueHarness({
    rows: [fileRow('a', { processingStage: 'uploaded', processingError: null, mimeType: 'audio/mpeg' })],
    jobs: { [jobIdFor('a', 'u1')]: { state: 'failed', failedReason: CANCELLED_NOTE, data: { fileId: 'a', userId: 'u1' },
      retry: async () => { retried += 1; } } },
  });
  // The recovery pass calls without retry.
  const out = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1' });
  assert.equal(out.queued, true);
  assert.equal(retried, 1, 'the stopped job runs again');
  assert.equal(files.get('a').processingStage, 'uploaded');
  assert.equal(files.get('a').processingError, null, 'never «se interrumpió»');
});

test('a job stopped from another process leaves a row asked for again alone; a Stop here still writes its note', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'extracting', path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null; },
    async updateMany({ where, data }) { const row = rows.get(where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  let engine;
  const inEngine = new Promise(resolve => { engine = resolve; });
  const service = createMediaTranscriptionService({ prisma, getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }),
    logger: { info() {}, warn() {} }, ownershipCheckMs: 20,
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => {
      engine();
      signal.addEventListener('abort', () => {
        // The user asked again right after the other process's Stop.
        rows.get('a').processingStage = 'uploaded';
        rows.get('a').processingError = null;
        reject(signal.reason);
      }, { once: true });
    }),
  });
  const running = service.processMediaJob({ data: { fileId: 'a', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0, discard() {} });
  await inEngine;
  rows.get('a').processingStage = 'failed';
  rows.get('a').processingError = CANCELLED_NOTE;
  assert.equal((await settledWithin(running)).error?.code, 'media_cancelled');
  assert.equal(rows.get('a').processingStage, 'uploaded', 'the new request is not overwritten by the old Stop');
  assert.equal(rows.get('a').processingError, null);

  // Stopped here: the job writes the note itself.
  rows.set('b', fileRow('b', { processingStage: 'extracting', path: '/tmp/b.mp4', mimeType: 'audio/mpeg' }));
  let engineB;
  const inEngineB = new Promise(resolve => { engineB = resolve; });
  const local = createMediaTranscriptionService({ prisma, getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/b' }),
    logger: { info() {}, warn() {} }, ownershipCheckMs: 0,
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => {
      engineB();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const runningB = local.processMediaJob({ data: { fileId: 'b', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0, discard() {} });
  await inEngineB;
  await local.cancelMediaTranscription({ fileIds: ['b'], userId: 'u1' });
  await assert.rejects(runningB, { code: 'media_cancelled' });
  assert.equal(rows.get('b').processingStage, 'failed');
  assert.equal(rows.get('b').processingError, CANCELLED_NOTE);
});

test('a copy of a hand-off saved from a share keeps its words, not the sharer\'s transcription', () => {
  const { withoutMediaDeliveryState } = require('../src/utils/copied-message-metadata');
  const handoff = { stoppedReason: 'media_delivery_handoff', mediaDeliveryHandoff: 'md_1', transcriptionFileIds: ['a'], servedBy: 'media_batch' };
  assert.deepEqual(withoutMediaDeliveryState(handoff), { transcriptionFileIds: ['a'], servedBy: 'media_batch', mediaDeliveryCopy: true });
  assert.equal(withoutMediaDeliveryState(JSON.stringify({ mediaDeliveryAmended: 'md_2', stoppedReason: 'media_delivery_amended' })),
    JSON.stringify({ mediaDeliveryCopy: true }));
  const plain = { model: 'x' };
  assert.equal(withoutMediaDeliveryState(plain), plain, 'other metadata is untouched');
  assert.equal(withoutMediaDeliveryState(null), null);
  assert.equal(withoutMediaDeliveryState('not json'), 'not json');
  const route = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'routes', 'chats.js'), 'utf8');
  const save = route.slice(route.indexOf("router.post('/save-shared'"), route.indexOf('// Return the new chat with its messages'));
  assert.equal((save.match(/metadata: withoutMediaDeliveryState\(/g) || []).length, 3, 'message, reply and whole-chat copies');
});
