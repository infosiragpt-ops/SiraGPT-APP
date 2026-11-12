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

// SQL's three-valued NOT over an AND of equalities: a NULL column makes the
// comparison unknown, and NOT unknown matches nothing (PostgreSQL).
function sqlNot(row, clause) {
  const values = Object.entries(clause).map(([key, value]) => (row[key] == null ? null : row[key] === value));
  const and = values.includes(false) ? false : values.includes(null) ? null : true;
  return and === null ? false : !and;
}

// A prisma fake that honours the filters the queue's guarded writes use.
function strictFilePrisma(rows, { staleReads = new Map() } = {}) {
  const fits = (row, where) => Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(clause => fits(row, clause));
    if (key === 'NOT') return sqlNot(row, value);
    if (value === null) return row[key] == null;
    if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
    if (value && typeof value === 'object' && 'not' in value) return row[key] != null && row[key] !== value.not;
    return row[key] === value;
  });
  return { file: {
    async findFirst({ where }) {
      const row = staleReads.get(where.id) || rows.get(where.id);
      return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null;
    },
    async updateMany({ where, data }) {
      const row = rows.get(where.id);
      if (!row || !fits(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  } };
}

test('Stop writes the stop state itself: an aborted job that never writes the row leaves nothing to re-queue', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'uploaded', mimeType: 'audio/mpeg', path: '/tmp/a.mp3' })]]);
  const prisma = strictFilePrisma(rows);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let finish;
  const service = createMediaTranscriptionService({ prisma, getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }), logger: { info() {}, warn() {} },
    // An offload or a park that ignores the abort: the job's own failure path never runs.
    processFile: () => new Promise((_resolve, reject) => { started(); finish = reject; }),
  });
  const job = service.processMediaJob({ data: { fileId: 'a', userId: 'u1' }, opts: { attempts: 1 }, attemptsMade: 0 });
  await ready;
  const out = await service.cancelMediaTranscription({ fileIds: ['a'], userId: 'u1' });
  assert.equal(out.results[0].outcome, 'aborted');
  assert.equal(rows.get('a').processingStage, 'failed', 'stopped at once, not when the job gets to it');
  assert.equal(rows.get('a').processingError, CANCELLED_NOTE);
  finish(Object.assign(new Error('x'), { code: 'media_cancelled' }));
  await job.catch(() => {});
  // A gap retry marked meanwhile goes back to its partial transcript.
  rows.set('b', fileRow('b', { processingStage: 'uploaded', extractedText: TRANSCRIPT, processingError: RETRYING_PARTIAL, mimeType: 'audio/mpeg' }));
  await service.cancelMediaTranscription({ fileIds: ['b'], userId: 'u1' });
  assert.equal(rows.get('b').processingStage, 'ready');
  assert.match(rows.get('b').processingError, /^Parcial:/);
});

test('Stop never writes its note over a transcript that finished between its read and its write', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT, mimeType: 'audio/mpeg' })]]);
  // Stop read the row while it was still extracting.
  const prisma = strictFilePrisma(rows, { staleReads: new Map([['a', fileRow('a', { processingStage: 'extracting', mimeType: 'audio/mpeg' })]]) });
  const service = createMediaTranscriptionService({ prisma, getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    processFile: async () => ({}), logger: { info() {}, warn() {} } });
  await service.cancelMediaTranscription({ fileIds: ['a'], userId: 'u1' });
  assert.equal(rows.get('a').processingStage, 'ready');
  assert.equal(rows.get('a').processingError ?? null, null);
});

test('the recovery pass never erases a Stop that landed after it read the row, nor queues the recording', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'failed', processingError: CANCELLED_NOTE, mimeType: 'audio/mpeg' })]]);
  // The 60 s tick read it as uploaded, just before the Stop.
  const prisma = strictFilePrisma(rows, { staleReads: new Map([['a', fileRow('a', { processingStage: 'uploaded', mimeType: 'audio/mpeg' })]]) });
  const added = [];
  const service = createMediaTranscriptionService({ prisma, now: () => T0, processFile: async () => ({}), logger: { info() {}, warn() {} },
    getQueue: () => ({ getJob: async () => null, add: async (name, data) => { added.push(data); return {}; } }) });
  const out = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1' });
  assert.equal(out.queued, false);
  assert.deepEqual(added, []);
  assert.equal(rows.get('a').processingError, CANCELLED_NOTE, 'the Stop stays');
  // An explicit request after the Stop still resumes it.
  const asked = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1', retry: true });
  assert.equal(asked.queued, true);
  assert.equal(added.length, 1);
});

test('the stop guard matches rows with NULL columns as PostgreSQL does: a legacy row is still reset and queued', async () => {
  // NOT (stage = 'failed' AND error = note) is unknown for (NULL, NULL) and (failed, NULL) in SQL.
  for (const extra of [{ processingStage: null, processingError: null }, { processingStage: 'uploaded', processingError: null },
    { processingStage: null, processingError: CANCELLED_NOTE }]) {
    const rows = new Map([['a', fileRow('a', { ...extra, mimeType: 'audio/mpeg' })]]);
    const added = [];
    const service = createMediaTranscriptionService({ prisma: strictFilePrisma(rows), now: () => T0, processFile: async () => ({}),
      logger: { info() {}, warn() {} }, getQueue: () => ({ getJob: async () => null, add: async (name, data) => { added.push(data); return {}; } }) });
    const out = await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1' });
    assert.equal(out.queued, true, JSON.stringify(extra));
    assert.equal(added.length, 1, JSON.stringify(extra));
    assert.equal(rows.get('a').processingStage, 'uploaded');
  }
  assert.equal(sqlNot({ processingStage: 'failed', processingError: null }, { processingStage: 'failed', processingError: CANCELLED_NOTE }), false,
    'the fake reads NOT as SQL does');
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
  const block = source.slice(source.indexOf('const ownHints = '), source.indexOf("if (amended?.outcome === 'amended' || amended?.outcome === 'unchanged')"));
  assert.match(block, /mediaBatch\.extractTranscriptionHints\(mediaGoal, \[\]\)/);
  assert.ok(block.indexOf('const ownHints = ') >= 0 && block.indexOf('const ownHints = ') < block.indexOf('let amended = await pendingService.amendDelivery('));
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
  assert.match(source, /const windows = translationWindowsOf\(delivery\);/, 'the translation reads its windows, over the transcript\'s range');
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

// The real analysis and translation (defaultAnalyze), not a stub: a Stop
// aborts their model calls, so a 100-recording translation stops paying.
test('Stop aborts the real translation and analysis model calls, not only a stub', async () => {
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const runtimePath = require.resolve('../src/services/media-analysis-runtime');
  const saved = new Map([runnerPath, runtimePath].map(p => [p, require.cache[p]]));
  const fake = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  let controller;
  let calls = 0;
  const signals = [];
  fake(runnerPath, { normalizeAgentRuntimeModel: () => ({ runtimeModel: 'm' }), resolveAgentRuntimeClient: () => ({ client: {}, model: 'm', provider: 'p' }),
    pinnedModelLabel: () => 'M' });
  fake(runtimePath, { createMediaAnalysisCompletion: () => ({ complete: async (messages, signal) => {
    calls += 1;
    signals.push(signal);
    if (calls === 2) controller.abort(Object.assign(new Error('Stop'), { code: 'delivery_cancelled' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    // Echo the fragment as its own «translation» or note.
    try { return JSON.parse(messages[messages.length - 1].content).transcript || 'nota'; } catch (_) { return 'nota'; }
  } }) });
  try {
    delete require.cache[require.resolve('../src/services/media-delivery')];
    const { defaultAnalyze } = require('../src/services/media-delivery');
    const long = Array.from({ length: 4000 }, (_, i) => `[01:${String(i % 60).padStart(2, '0')}:00] Frase ${i} del profesor sobre la célula y la mitocondria.`).join('\n');
    const rows = [{ id: 'a', originalName: 'a.mp4', extractedText: long, processingStage: 'ready' }];
    for (const delivery of [
      { userId: 'u1', chatId: 'c', mode: 'translation', goal: 'tradúcelo al inglés', output: { translationTarget: 'en' }, model: { id: 'm' } },
      { userId: 'u1', chatId: 'c', mode: 'analysis', goal: 'resume la clase', output: {}, model: { id: 'm' } },
    ]) {
      calls = 0;
      signals.length = 0;
      controller = new AbortController();
      await assert.rejects(defaultAnalyze({ rows, delivery, prisma: null, signal: controller.signal }));
      assert.ok(calls >= 2 && calls <= 6, `${delivery.mode}: ${calls} calls, the rest never ran`);
      assert.ok(signals.every(signal => signal && typeof signal.aborted === 'boolean'), 'every call carries the abort signal');
    }
  } finally {
    for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
    delete require.cache[require.resolve('../src/services/media-delivery')];
  }
});

// ── coverage the review of the fixes asked for: each fails without its fix ──

function slowAnalyze(record) {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const analyze = async ({ signal }) => new Promise((resolve, reject) => {
    record.signal = signal;
    started();
    const timer = setTimeout(() => resolve('análisis'), 15_000);
    signal?.addEventListener('abort', () => { record.abortedAt = Date.now(); clearTimeout(timer); reject(signal.reason || new Error('aborted')); }, { once: true });
  });
  return { analyze, ready };
}

test('a Stop written by another process (its marker) aborts the analysis this process is running', async (t) => {
  const seen = {};
  const { analyze, ready } = slowAnalyze(seen);
  const { service, state, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })], overrides: { analyze } });
  const record = await service.createDelivery(request({ mode: 'analysis', goal: 'resume la clase' }));
  const run = service.deliverOne(record.id);
  await ready;
  // Another process (its own store on the same disk) presses Stop: the lock is held here, so it leaves the marker.
  const other = createMediaDeliveryStore({ root: store.root, now: () => T0 });
  assert.equal((await other.cancel(record.id, { userId: 'u1', tries: 1, waitMs: 1 })).outcome, 'cancel_requested');
  const outcome = await run;
  assert.ok(seen.abortedAt, 'the holder watched the marker and aborted its analysis');
  assert.equal(outcome.status, 'cancelled');
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind !== 'cancelled').length, 0, 'no transcript after the Stop');
});

test('a Stop in this process aborts the analysis at once, before the lock retries', async (t) => {
  const seen = {};
  const { analyze, ready } = slowAnalyze(seen);
  const { service } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })], overrides: { analyze } });
  const record = await service.createDelivery(request({ mode: 'analysis', goal: 'resume la clase' }));
  const run = service.deliverOne(record.id);
  await ready;
  const pressed = Date.now();
  const stop = service.cancelDelivery(record.id, { userId: 'u1', waitMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(seen.abortedAt && seen.abortedAt - pressed < 60, `aborted ${seen.abortedAt ? seen.abortedAt - pressed : 'never'} ms after Stop`);
  await Promise.all([run, stop]);
});

test('Stop aborts a running refine of its own delivery and leaves another delivery\'s refine alone', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT, path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const service = createMediaTranscriptionService({ prisma: strictFilePrisma(rows), getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }), logger: { info() {}, warn() {} },
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }),
  });
  const refine = service.processMediaJob({ data: { fileId: 'a', userId: 'u1', refine: true, range: { start: 720, end: 900 }, deliveryId: 'd1' }, opts: { attempts: 1 }, attemptsMade: 0 });
  let settled = false;
  refine.then(() => { settled = true; }, () => { settled = true; });
  await ready;
  const other = await service.cancelMediaTranscription({ userId: 'u1', refines: [{ fileId: 'a', range: { start: 720, end: 900 }, deliveryId: 'd2' }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false, 'another delivery\'s Stop leaves it running');
  assert.notEqual(other.results[0].outcome, 'aborted');
  const own = await service.cancelMediaTranscription({ userId: 'u1', refines: [{ fileId: 'a', range: { start: 720, end: 900 }, deliveryId: 'd1' }] });
  assert.equal(own.results[0].outcome, 'aborted');
  await assert.rejects(refine);
  assert.equal(rows.get('a').extractedText, TRANSCRIPT, 'the transcript stays as it was');
});

test('a deploy park never erases a Stop another worker noted meanwhile', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'uploaded', path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let fail;
  const service = createMediaTranscriptionService({ prisma: strictFilePrisma(rows), getQueue: () => ({ getJob: async () => null, add: async () => ({}) }), now: () => T0,
    validate: async (_l, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => {}, dir: '/ckpt/a' }), logger: { info() {}, warn() {} },
    processFile: () => new Promise((_resolve, reject) => { started(); fail = reject; }),
  });
  const parked = [];
  const job = { data: { fileId: 'a', userId: 'u1' }, opts: { attempts: 3 }, attemptsMade: 0, discard() {},
    moveToDelayed: async (at, token) => { parked.push([at, token]); } };
  const run = service.processMediaJob(job, 'tok-1');
  await ready;
  // Another worker's Stop wrote the note; then this process shuts down for a deploy.
  Object.assign(rows.get('a'), { processingStage: 'failed', processingError: CANCELLED_NOTE });
  fail(Object.assign(new Error('deploy'), { code: 'media_shutdown' }));
  await run.catch(() => {});
  assert.equal(parked.length, 1, 'parked for the next worker');
  assert.equal(rows.get('a').processingStage, 'failed');
  assert.equal(rows.get('a').processingError, CANCELLED_NOTE, 'the Stop stays');
});

// ── the seventh round: a Stop is noted as done only once its jobs stopped ──

test('a Stop whose jobs did not all stop (a database outage) is never noted as done: the sweep stops them', async (t) => {
  let down = true;
  let outage = 'result';
  const calls = [];
  const { service, state, store } = await harness(t, { files: [fileRow('a')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    cancelMediaJobs: async (args) => {
      calls.push(args);
      if (outage === 'result') return { stopped: 0, results: [{ id: 'a', outcome: 'error', code: 'P1001' }] };
      if (outage === 'throw') throw Object.assign(new Error('db'), { code: 'P1001' });
      return { stopped: (args.fileIds || []).length, results: (args.fileIds || []).map(id => ({ id, outcome: 'stopped' })) };
    },
  } });
  const record = await service.createDelivery(request());
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  assert.equal(calls.length, 1, 'the Stop tried to stop the jobs');
  assert.notEqual((await store.cancelMarker(record.id))?.jobsStopped, true, 'a job left running is not «stopped»');
  // The next sweep still cannot post the line; this time stopping throws.
  outage = 'throw';
  assert.equal((await service.deliverOne(record.id)).status, 'cancelling');
  assert.equal(calls.length, 2, 'the sweep tries again');
  assert.notEqual((await store.cancelMarker(record.id))?.jobsStopped, true);
  // The database is back: the sweep stops the jobs, posts the line and closes the request.
  outage = null;
  down = false;
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.equal(calls.length, 3, 'and the jobs really stop');
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1);
});

test('a Stop left for a busy holder notes its jobs as stopped: a later sweep never stops a recording asked for again', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })] });
  const record = await service.createDelivery(request());
  // Another process holds the delivery (it is posting, or it died holding the lock).
  await store.claim(record.id);
  const out = await service.cancelDelivery(record.id, { userId: 'u1', waitMs: 0 });
  assert.equal(out.outcome, 'cancel_requested');
  assert.equal(state.stopped.filter(args => (args.fileIds || []).includes('a')).length, 1, 'the jobs stop with the Stop');
  assert.equal((await store.cancelMarker(record.id))?.jobsStopped, true);
  // The user asks for the recording again; the sweep that finishes this Stop leaves it alone.
  state.files.get('a').processingStage = 'uploaded';
  assert.equal((await service.deliverOne(record.id)).status, 'cancelling');
  assert.equal(state.stopped.filter(args => (args.fileIds || []).includes('a')).length, 1, 'nothing is stopped twice');
});

test('a failed recording whose audio the browser extracted keeps the uploaded name in the delivery, its notice and the chat title', async (t) => {
  const titles = [];
  const notices = [];
  const { service, state } = await harness(t, {
    files: [fileRow('a', { originalName: 'Clase 4.audio.ogg', filename: 'Clase 4.audio.ogg', mimeType: 'audio/ogg',
      processingStage: 'failed', processingError: 'No se detectó voz en este archivo.' })],
    overrides: {
      ensureChat: async ({ chatId, title }) => { titles.push(title); return { chatId, created: false }; },
      notify: async (notice) => { notices.push(JSON.stringify(notice)); },
    },
  });
  const record = await service.createDelivery(request({ fileNames: ['Clase 4.mp4'] }));
  await service.deliverOne(record.id);
  const posted = state.messages.map(message => message.content).join('\n');
  assert.match(posted, /Clase 4\.mp4/);
  assert.doesNotMatch(posted, /audio\.ogg/);
  assert.ok(titles.every(title => !/audio\.ogg/.test(String(title || ''))), titles.join(' | '));
  assert.ok(notices.every(notice => !/audio\.ogg/.test(notice)), notices.join(' | '));
});

test('a recording deleted since the Stop has nothing to stop: the Stop is noted as done for the others', async (t) => {
  let down = true;
  const calls = [];
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    cancelMediaJobs: async (args) => {
      calls.push(args);
      return { stopped: 1, results: [{ id: 'a', outcome: 'error', code: 'media_not_found' }, { id: 'b', outcome: 'stopped' }] };
    },
  } });
  const record = await service.createDelivery(request({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  assert.equal((await store.cancelMarker(record.id))?.jobsStopped, true, 'a deleted file is no job left running');
  // The user asks for «b» again; the sweep that posts the line never stops it again.
  down = false;
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.equal(calls.length, 1);
});

test('the delivery translates with the conditions the user gave in the request and its follow-ups', async () => {
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const runtimePath = require.resolve('../src/services/media-analysis-runtime');
  const saved = new Map([runnerPath, runtimePath].map(p => [p, require.cache[p]]));
  const fake = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const systems = [];
  fake(runnerPath, { normalizeAgentRuntimeModel: () => ({ runtimeModel: 'm' }), resolveAgentRuntimeClient: () => ({ client: {}, model: 'm', provider: 'p' }),
    pinnedModelLabel: () => 'M' });
  fake(runtimePath, { createMediaAnalysisCompletion: () => ({ complete: async (messages) => {
    systems.push(messages[0].content);
    try { return JSON.parse(messages[messages.length - 1].content).transcript || 'nota'; } catch (_) { return 'nota'; }
  } }) });
  try {
    delete require.cache[require.resolve('../src/services/media-delivery')];
    const { defaultAnalyze } = require('../src/services/media-delivery');
    const rows = [{ id: 'a', originalName: 'a.mp4', extractedText: '[00:00:00] Hola, soy Juan Pérez de la ONU.', processingStage: 'ready' }];
    await defaultAnalyze({ rows, prisma: null, delivery: { userId: 'u1', chatId: 'c', mode: 'translation', model: { id: 'm' },
      goal: 'transcribe y tradúcelo al inglés\n\nno traduzcas los nombres propios', output: { translationTarget: 'en' } } });
    assert.ok(systems.length > 0);
    assert.ok(systems.every(system => /«no traduzcas los nombres propios»/.test(system)), systems[0]);
  } finally {
    for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
    delete require.cache[require.resolve('../src/services/media-delivery')];
  }
});

test('the delivery names a recording stopped with «Detener» as stopped, never as a failure', () => {
  const { deliveryMessage } = require('../src/services/media-delivery');
  const rows = [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT, deliveryState: 'ready' }),
    fileRow('b', { processingStage: 'failed', processingError: CANCELLED_NOTE, deliveryState: 'failed' }),
    fileRow('c', { processingStage: 'failed', processingError: 'No se detectó voz en este archivo.', deliveryState: 'failed' })];
  const text = deliveryMessage({ delivery: { fileIds: ['a', 'b', 'c'], fileNames: ['a.mp4', 'b.mp4', 'c.mp4'], formats: ['txt'] }, rows,
    artifacts: [{ filename: 'a.txt', format: 'txt' }] });
  assert.match(text, /1 completo, 1 con error, 1 detenido/);
  assert.match(text, /«b\.mp4»: detenida \(escribe «retómala» para seguir donde quedó\)/);
  assert.match(text, /«c\.mp4»: no se pudo transcribir/);
  assert.doesNotMatch(text, /«b\.mp4»: no se pudo transcribir/);
});

// The real analysis step with the model calls faked: what each translation
// call reads, and the files it names.
async function translateWith(delivery, rows) {
  const runnerPath = require.resolve('../src/services/agents/agent-task-runner');
  const runtimePath = require.resolve('../src/services/media-analysis-runtime');
  const saved = new Map([runnerPath, runtimePath].map(p => [p, require.cache[p]]));
  const fake = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  const calls = [];
  fake(runnerPath, { normalizeAgentRuntimeModel: () => ({ runtimeModel: 'm' }), resolveAgentRuntimeClient: () => ({ client: {}, model: 'm', provider: 'p' }),
    pinnedModelLabel: () => 'M' });
  fake(runtimePath, { createMediaAnalysisCompletion: () => ({ complete: async (messages) => {
    const system = String(messages[0].content || '');
    let transcript = '';
    try { transcript = JSON.parse(messages[messages.length - 1].content).transcript || ''; } catch (_) { transcript = String(messages[messages.length - 1].content || ''); }
    calls.push({ system, transcript });
    return transcript.replace(/Hola/g, /francés|french/i.test(system) ? 'Bonjour' : 'Hello');
  } }) });
  try {
    delete require.cache[require.resolve('../src/services/media-delivery')];
    const { defaultAnalyze } = require('../src/services/media-delivery');
    const result = await defaultAnalyze({ rows, prisma: null, delivery: { userId: 'u1', chatId: 'c', mode: 'translation', model: { id: 'm' }, ...delivery } });
    return { result, calls };
  } finally {
    for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
    delete require.cache[require.resolve('../src/services/media-delivery')];
  }
}

const THREE_HOURS_SEGMENTS = [
  [600, 'Hola, minuto diez.'], [660, 'Hola, todavía el minuto once.'],
  [3600, 'Hola, la hora uno que nadie pidió.'], [5400, 'Hola, hora y media que nadie pidió.'],
  [9000, 'Hola, minuto ciento cincuenta.'], [9060, 'Hola, ciento cincuenta y uno.'],
].map(([start, text]) => ({ start, end: start + 30, text }));
const THREE_HOURS = THREE_HOURS_SEGMENTS.map(seg => `[${new Date(seg.start * 1000).toISOString().slice(11, 19)}] ${seg.text}`).join('\n');
const THREE_HOURS_SIDECARS = { a: { language: 'es', durationSec: 10800, segments: THREE_HOURS_SEGMENTS } };

test('two moments far apart translate only those two windows, and the files name both', async () => {
  const rows = [{ id: 'a', originalName: 'clase.mp4', extractedText: THREE_HOURS, processingStage: 'ready' }];
  const { result, calls } = await translateWith({ goal: 'traduce al inglés lo del minuto 10\n\ny traduce también al inglés lo del minuto 150',
    transcripts: THREE_HOURS_SIDECARS, output: { translationTarget: 'en', translationRanges: [{ start: 540, end: 840 }, { start: 8940, end: 9240 }] } }, rows);
  const read = calls.map(call => call.transcript).join('\n');
  assert.match(read, /minuto diez/);
  assert.match(read, /minuto ciento cincuenta/);
  assert.doesNotMatch(read, /nadie pidió/, 'nothing between the two moments is translated');
  const names = result.artifacts.map(artifact => artifact.filename);
  assert.ok(names.some(name => /00\.09\.00–00\.14\.00, 02\.29\.00–02\.34\.00/.test(name)), names.join(' | '));
  // An open range stays «desde …», never «168.00.00».
  const open = await translateWith({ goal: 'transcribe desde el minuto 30 y tradúcelo al inglés',
    transcripts: THREE_HOURS_SIDECARS, output: { translationTarget: 'en', translationRanges: [{ start: 540, end: 840 }, { start: 1800, end: null }] } }, rows);
  const openNames = open.result.artifacts.map(artifact => artifact.filename).join(' | ');
  assert.match(openNames, /09\.00–14\.00, desde 30\.00/);
  assert.doesNotMatch(openNames, /168/);
});

test('a second language translates its own moment and the first stays whole', async () => {
  const rows = [{ id: 'a', originalName: 'clase.mp4', extractedText: THREE_HOURS, processingStage: 'ready' }];
  const { result, calls } = await translateWith({ goal: 'transcribe y tradúcelo al inglés\n\ntraduce también al francés lo del minuto 150',
    transcripts: THREE_HOURS_SIDECARS, output: { translationTarget: 'en', extraTranslations: [{ target: 'fr', ranges: [{ start: 8940, end: 9240 }] }] } }, rows);
  const english = calls.filter(call => !/francés|french/i.test(call.system)).map(call => call.transcript).join('\n');
  const french = calls.filter(call => /francés|french/i.test(call.system)).map(call => call.transcript).join('\n');
  assert.match(english, /nadie pidió/, 'the English translation is whole');
  assert.match(french, /minuto ciento cincuenta/);
  assert.doesNotMatch(french, /minuto diez|nadie pidió/, 'the French one only reads its moment');
  const names = result.artifacts.map(artifact => artifact.filename);
  assert.ok(names.some(name => /traducción al inglés\)\.txt$/.test(name)), names.join(' | '));
  assert.ok(names.some(name => /traducción al francés 02\.29\.00–02\.34\.00\)\.txt$/.test(name)), names.join(' | '));
  assert.match(result.text, /#### Al inglés/);
  assert.match(result.text, /#### Al francés \(02:29:00–02:34:00\)/);
  assert.match(result.text, /Bonjour/);
});

// ── eighth review: a Stop whose job stop failed for a moment ─────────────────

// The first stop of «b» hits a database blip; later ones work.
function flakyStop(calls, { failFor = ['b'], times = 1 } = {}) {
  let left = times;
  return async (args) => {
    calls.push(JSON.parse(JSON.stringify(args)));
    const fail = left > 0;
    if (fail) left -= 1;
    const results = (args.fileIds || []).map(id => (fail && failFor.includes(id) ? { id, outcome: 'error', code: 'P2024' } : { id, outcome: 'stopped' }));
    return { stopped: results.filter(item => item.outcome === 'stopped').length, results };
  };
}

test('a Stop retries only the jobs it could not stop: a recording asked for again is never stopped twice', async (t) => {
  let down = true;
  const calls = [];
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    cancelMediaJobs: flakyStop(calls),
  } });
  const record = await service.createDelivery(request({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  const marker = await store.cancelMarker(record.id);
  assert.notEqual(marker?.jobsStopped, true);
  assert.deepEqual(marker?.pendingStops, { fileIds: ['b'], refines: [] }, '«a» stopped; only «b» is left');
  // The user asks for «a» again; the sweep that posts the line stops «b» only.
  down = false;
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.deepEqual(calls.map(call => call.fileIds), [['a', 'b'], ['b']]);
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1);
});

test('asking again for the recording whose stop failed releases it: the sweep never stops it', async (t) => {
  let down = true;
  const calls = [];
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b')], overrides: {
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (down) throw Object.assign(new Error('db'), { code: 'P1001' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    cancelMediaJobs: flakyStop(calls),
  } });
  const record = await service.createDelivery(request({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  await service.cancelDelivery(record.id, { userId: 'u1' });
  assert.equal(await service.releasePendingStops({ userId: 'u1', fileIds: ['b'] }), 1);
  assert.equal((await store.cancelMarker(record.id))?.jobsStopped, true);
  down = false;
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.equal(calls.length, 1, '«b», asked for again, is never stopped by the sweep');
  // Another user's request never releases this one.
  assert.equal(await service.releasePendingStops({ userId: 'u2', fileIds: ['b'] }), 0);
});

test('a Stop whose line posts but whose job stop fails keeps the request open until the sweep stops it', async (t) => {
  const calls = [];
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b')], overrides: { cancelMediaJobs: flakyStop(calls) } });
  const record = await service.createDelivery(request({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  const out = await service.cancelDelivery(record.id, { userId: 'u1' });
  assert.equal(out.outcome, 'cancel_requested', 'not done while «b» still transcribes');
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1, 'the line is in the chat');
  assert.ok(await store.get(record.id), 'the request stays open');
  assert.deepEqual((await store.cancelMarker(record.id))?.pendingStops, { fileIds: ['b'], refines: [] });
  // The sweep stops «b» and only then closes, without a second line.
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.deepEqual(calls.map(call => call.fileIds), [['a', 'b'], ['b']]);
  assert.equal(state.messages.filter(message => message.metadata.deliveryKind === 'cancelled').length, 1);
  assert.equal((await store.get(record.id))?.status, 'cancelled');
});

test('a holder that honours a Stop mid-analysis keeps the request open while a job could not be stopped', async (t) => {
  const seen = {};
  const { analyze, ready } = slowAnalyze(seen);
  const calls = [];
  const { service, store } = await harness(t, { files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT }),
    fileRow('b', { processingStage: 'ready', extractedText: TRANSCRIPT })], overrides: { analyze, cancelMediaJobs: flakyStop(calls) } });
  const record = await service.createDelivery(request({ mode: 'analysis', goal: 'resume la clase', fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  const run = service.deliverOne(record.id);
  await ready;
  const other = createMediaDeliveryStore({ root: store.root, now: () => T0 });
  assert.equal((await other.cancel(record.id, { userId: 'u1', tries: 1, waitMs: 1 })).outcome, 'cancel_requested');
  const outcome = await run;
  assert.equal(outcome.status, 'cancelling', 'a job still running keeps it open');
  assert.ok(await store.get(record.id));
  assert.equal((await service.deliverOne(record.id)).status, 'cancelled');
  assert.deepEqual(calls.map(call => call.fileIds), [['a', 'b'], ['b']]);
});

test('a second press of Stop stops only what the first one left', async (t) => {
  const calls = [];
  const { service, store } = await harness(t, { files: [fileRow('a'), fileRow('b')], overrides: { cancelMediaJobs: flakyStop(calls, { times: 2 }) } });
  const record = await service.createDelivery(request({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancel_requested');
  assert.deepEqual(calls.map(call => call.fileIds), [['a', 'b'], ['b']], '«a», asked for again in between, is never stopped twice');
  assert.equal((await service.cancelDelivery(record.id, { userId: 'u1' })).outcome, 'cancelled');
  assert.deepEqual(calls.map(call => call.fileIds), [['a', 'b'], ['b'], ['b']]);
  assert.equal((await store.get(record.id))?.status, 'cancelled');
});
