'use strict';

// «Detener» on a transcription the chat handed off, and follow-ups that
// join the pending delivery instead of starting a second transcription.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const delivery = require('../src/services/media-delivery');
const {
  createMediaDeliveryStore, mergeDeliveryAmendment, normalizeNewRecord, MAX_FILES,
} = require('../src/services/media-delivery-store');

const { createMediaDeliveryService, cancelledMessage, amendedMessage, stillRunningMessage } = delivery;

const T0 = Date.parse('2026-11-05T10:00:00Z');
const ENABLED = { SIRAGPT_MEDIA_DELIVERY: '1' };
const TRANSCRIPT = 'Buenos días a todos. Hoy hablamos de la mitocondria.';

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-delivery-stop-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fileRow(id, extra = {}) {
  return { id, userId: 'u1', originalName: `${id}.mp4`, filename: `${id}.mp4`, mimeType: 'video/mp4',
    processingStage: 'extracting', processingError: null, extractedText: null, deletedAt: null, ...extra };
}

async function harness(t, { files = [], chats = ['chat1'], overrides = {} } = {}) {
  const root = await tempRoot(t);
  const clock = { t: T0 };
  const now = () => clock.t;
  const state = { files: new Map(files.map(row => [row.id, { ...row }])), chats: new Set(chats), messages: [],
    notifications: [], stopped: [], hints: [] };
  const metadataFilters = where => [where.metadata, ...(Array.isArray(where.AND) ? where.AND.map(clause => clause.metadata) : [])]
    .filter(Boolean);
  const prisma = {
    message: {
      async findFirst({ where }) {
        const filters = metadataFilters(where);
        const found = state.messages.find(m => m.chatId === where.chatId
          && filters.every(filter => m.metadata?.[filter.path[0]] === filter.equals));
        return found ? { id: found.id, chatId: found.chatId } : null;
      },
    },
  };
  const store = createMediaDeliveryStore({ root, now });
  const deps = {
    env: ENABLED, now, prisma, store,
    logger: { info() {}, warn() {} },
    loadFiles: async (userId, ids) => ids.map(id => state.files.get(id)).filter(row => row && row.userId === userId).map(row => ({ ...row })),
    loadTranscript: async () => null,
    readJobStates: async ({ fileIds }) => Object.fromEntries(fileIds.map(id => [id, 'active'])),
    buildArtifacts: async () => [{ filename: 'clase.txt', base64: Buffer.from(TRANSCRIPT).toString('base64'), mime: 'text/plain' }],
    saveArtifact: ({ filename, mime }) => ({ id: `art_${filename}`, filename, format: 'txt', mime, downloadUrl: '/x' }),
    persistArtifact: async () => {},
    postMessage: async ({ userId, chatId, content, metadata }) => {
      if (!state.chats.has(chatId)) throw Object.assign(new Error('chat missing'), { code: 'chat_unavailable' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    ensureChat: async ({ chatId }) => ({ chatId, created: false }),
    notify: async payload => { state.notifications.push(payload); },
    cancelMediaJobs: async ({ fileIds, userId }) => { state.stopped.push({ fileIds, userId }); return { stopped: fileIds.length }; },
    recordHints: async args => { state.hints.push(args); return { ok: true }; },
    analyze: null,
    ...overrides,
  };
  return { service: createMediaDeliveryService(deps), state, store, clock, root };
}

function request(extra = {}) {
  return { userId: 'u1', chatId: 'chat1', taskId: 'task1', fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'],
    goal: 'transcribir', mode: 'transcript', formats: ['txt'], ...extra };
}

// ── the amendment merge (pure) ──────────────────────────────────────────

test('a translation follow-up keeps the transcript the first request asked for', () => {
  const record = normalizeNewRecord(request(), T0);
  const { record: next, changes } = mergeDeliveryAmendment(record, { goal: 'y tradúcelo al inglés', translationTarget: 'en' });
  assert.deepEqual(changes, ['translation']);
  assert.equal(next.mode, 'translation');
  assert.equal(next.output.includeTranscript, true, 'the transcript files still come');
  assert.equal(next.output.translationTarget, 'en');
  assert.match(next.goal, /^transcribir\n\ny tradúcelo al inglés$/);
  // A later «mejor al francés» changes only the target, explicitly.
  const second = mergeDeliveryAmendment(next, { goal: 'mejor al francés', translationTarget: 'fr' });
  assert.deepEqual(second.changes, ['translation_target']);
  assert.equal(second.record.output.translationTarget, 'fr');
  // The same target again is nothing new.
  assert.deepEqual(mergeDeliveryAmendment(second.record, { translationTarget: 'fr' }).changes, []);
});

test('Word, subtitles, a summary, a range, names: each follow-up adds only what it says', () => {
  const record = normalizeNewRecord(request(), T0);
  const word = mergeDeliveryAmendment(record, { goal: 'en Word', documentFormat: 'docx' });
  assert.deepEqual(word.changes, ['document']);
  assert.equal(word.record.output.documentFormat, 'docx');
  assert.deepEqual(word.record.formats, ['txt', 'docx']);
  assert.equal(word.record.mode, 'transcript', 'a Word file is not an analysis');

  const subs = mergeDeliveryAmendment(word.record, { wantsSubtitles: true });
  assert.deepEqual(subs.changes, ['subtitles']);
  assert.deepEqual(subs.record.formats, ['txt', 'srt', 'vtt', 'docx']);

  const summary = mergeDeliveryAmendment(subs.record, { goal: 'resúmelo', wantsAnalysis: true });
  assert.deepEqual(summary.changes, ['analysis']);
  assert.equal(summary.record.mode, 'analysis');

  // A summary asked after a translation rides with it.
  const translated = mergeDeliveryAmendment(record, { translationTarget: 'en' }).record;
  const both = mergeDeliveryAmendment(translated, { wantsAnalysis: true });
  assert.deepEqual(both.changes, ['analysis']);
  assert.equal(both.record.mode, 'translation');
  assert.equal(both.record.output.alsoAnalysis, true);

  const ranged = mergeDeliveryAmendment(record, { range: { start: 600, end: 1200 } });
  assert.deepEqual(ranged.changes, ['range']);
  assert.deepEqual(ranged.record.range, { start: 600, end: 1200 });

  const named = mergeDeliveryAmendment({ ...record, hints: { terms: ['Huamán'] } }, { hints: { terms: ['Ayacucho'], speakers: 3 } });
  assert.deepEqual(named.changes, ['hints']);
  assert.deepEqual(named.record.hints.terms, ['Huamán', 'Ayacucho']);
  assert.equal(named.record.hints.speakers, 3);
  assert.deepEqual(mergeDeliveryAmendment(record, { goal: 'transcribir' }).changes, [], 'a repeated request adds nothing');
});

test('a batch of 100 recordings fits one delivery', () => {
  assert.ok(MAX_FILES >= 100);
  const ids = Array.from({ length: 100 }, (_, i) => `f${i}`);
  assert.equal(normalizeNewRecord({ userId: 'u1', fileIds: ids }, T0).fileIds.length, 100);
  assert.throws(() => normalizeNewRecord({ userId: 'u1', fileIds: Array.from({ length: MAX_FILES + 1 }, (_, i) => `f${i}`) }), { code: 'invalid_record' });
});

// ── store: cancel and amend ─────────────────────────────────────────────

test('store.cancel closes a waiting delivery for its owner only', async (t) => {
  const store = createMediaDeliveryStore({ root: await tempRoot(t), now: () => T0 });
  const record = await store.create(request());
  assert.equal((await store.cancel(record.id, { userId: 'someone-else' })).outcome, 'missing');
  assert.equal((await store.get(record.id)).status, 'pending', 'a foreign cancel touches nothing');
  const out = await store.cancel(record.id, { userId: 'u1' });
  assert.equal(out.outcome, 'cancelled');
  assert.equal((await store.get(record.id)).status, 'cancelled');
  assert.deepEqual(await store.listActive(), []);
  assert.equal(await store.claim(record.id), null, 'nothing can deliver it now');
  assert.equal((await store.cancel(record.id, { userId: 'u1' })).outcome, 'already_cancelled');
});

test('a Stop pressed while a holder delivers leaves a marker the holder honours', async (t) => {
  const store = createMediaDeliveryStore({ root: await tempRoot(t), now: () => T0 });
  const record = await store.create(request());
  const held = await store.claim(record.id);
  assert.ok(held?.token);
  const out = await store.cancel(record.id, { userId: 'u1', tries: 2, waitMs: 5 });
  assert.equal(out.outcome, 'cancel_requested');
  assert.equal(await store.isCancelRequested(record.id), true);
  const closed = await store.markCancelled(record.id, held.token);
  assert.equal(closed.status, 'cancelled');
  assert.equal(await store.isCancelRequested(record.id), false, 'the marker goes with the record');

  // A holder that released instead: the next claim closes it.
  const other = await store.create(request());
  const again = await store.claim(other.id);
  await store.cancel(other.id, { userId: 'u1', tries: 1, waitMs: 1 });
  await store.release(other.id, again.token);
  assert.equal(await store.claim(other.id), null);
  assert.equal((await store.get(other.id)).status, 'cancelled');
});

test('store.amend folds a follow-up only while the delivery waits', async (t) => {
  const store = createMediaDeliveryStore({ root: await tempRoot(t), now: () => T0 });
  const record = await store.create(request());
  const out = await store.amend(record.id, { userId: 'u1', amendment: { goal: 'en Word', documentFormat: 'docx' } });
  assert.equal(out.outcome, 'amended');
  assert.deepEqual(out.changes, ['document']);
  const saved = await store.get(record.id);
  assert.equal(saved.output.documentFormat, 'docx');
  assert.equal(saved.amendments.length, 1);
  assert.equal((await store.amend(record.id, { userId: 'u2', amendment: { documentFormat: 'pdf' } })).outcome, 'missing');
  assert.equal((await store.amend(record.id, { userId: 'u1', amendment: { goal: 'en Word', documentFormat: 'docx' } })).outcome, 'unchanged');

  const held = await store.claim(record.id);
  assert.equal((await store.amend(record.id, { userId: 'u1', amendment: { wantsSubtitles: true }, tries: 2, waitMs: 5 })).outcome, 'too_late');
  await store.release(record.id, held.token);
  assert.equal((await store.amend(record.id, { userId: 'u1', amendment: { wantsSubtitles: true } })).outcome, 'amended');

  const refine = await store.create({ ...request({ fileIds: ['a'], fileNames: ['a.mp4'] }), kind: 'refine', range: { start: 10, end: 20 } });
  assert.equal((await store.amend(refine.id, { userId: 'u1', amendment: { documentFormat: 'docx' } })).outcome, 'unsupported');
  await store.cancel(record.id, { userId: 'u1' });
  assert.equal((await store.amend(record.id, { userId: 'u1', amendment: { documentFormat: 'pdf' } })).outcome, 'missing');
});

test('store.listActiveForChat returns the open deliveries of that chat and user', async (t) => {
  const store = createMediaDeliveryStore({ root: await tempRoot(t), now: () => T0 });
  const mine = await store.create(request());
  await store.create(request({ chatId: 'chat2' }));
  await store.create(request({ userId: 'u2' }));
  const listed = await store.listActiveForChat('chat1', { userId: 'u1' });
  assert.deepEqual(listed.map(record => record.id), [mine.id]);
});

// ── service: «Detener» ──────────────────────────────────────────────────

test('cancelChatDeliveries stops the recordings and settles the turn with one line', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('a'), fileRow('b'), fileRow('c')] });
  const record = await service.createDelivery(request());
  // Another open request (another chat) still waits on «b»: it keeps transcribing.
  state.chats.add('chat2');
  await service.createDelivery(request({ chatId: 'chat2', fileIds: ['b', 'c'], fileNames: ['b.mp4', 'c.mp4'] }));
  const out = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1' });
  assert.equal(out.cancelled, 1);
  assert.deepEqual(state.stopped, [{ fileIds: ['a'], userId: 'u1' }]);
  assert.equal(state.messages.length, 1);
  const [note] = state.messages;
  assert.equal(note.chatId, 'chat1');
  assert.equal(note.metadata.source, 'media-delivery');
  assert.equal(note.metadata.mediaDelivery, record.id, 'the line settles the hand-off on reload');
  assert.deepEqual(note.metadata.transcriptionFileIds, ['a', 'b']);
  assert.equal(note.metadata.deliveryKind, 'cancelled');
  assert.match(note.content, /^Detuve la transcripción de 2 archivos/);
  assert.equal((await store.get(record.id)).status, 'cancelled');
  // The terminal hook of a stopped file posts nothing for it.
  await service.onMediaTerminal({ fileId: 'a', userId: 'u1' });
  assert.equal(state.messages.length, 1);
  // A second Stop is a no-op.
  const again = await service.cancelChatDeliveries({ userId: 'u1', chatId: 'chat1', deliveryIds: [record.id] });
  assert.equal(again.cancelled, 0);
  assert.equal(again.results[0].outcome, 'already_cancelled');
  assert.equal(state.messages.length, 1);
});

test('a Stop found mid-delivery posts nothing for that delivery', async (t) => {
  let storeRef = null;
  let recordId = null;
  const { service, state } = await harness(t, {
    files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })],
    overrides: {
      analyze: async () => {
        // The user presses Stop while the summary is being written.
        await storeRef.cancel(recordId, { userId: 'u1', tries: 1, waitMs: 1 });
        return 'resumen';
      },
    },
  });
  storeRef = service.store;
  const record = await service.createDelivery(request({ fileIds: ['a'], fileNames: ['a.mp4'], mode: 'analysis' }));
  recordId = record.id;
  const result = await service.deliverOne(record.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(state.messages.length, 0, 'no transcript posted after Stop');
  assert.equal((await service.store.get(record.id)).status, 'cancelled');
});

test('a delivery that fails for good leaves one line in the chat', async (t) => {
  const { service, state } = await harness(t, {
    files: [fileRow('a', { processingStage: 'ready', extractedText: TRANSCRIPT })],
    overrides: { maxAttempts: 1, buildArtifacts: async () => { throw Object.assign(new Error('disk'), { code: 'artifact_error' }); } },
  });
  const record = await service.createDelivery(request({ fileIds: ['a'], fileNames: ['a.mp4'] }));
  const result = await service.deliverOne(record.id);
  assert.equal(result.status, 'failed');
  const notes = state.messages.filter(message => message.metadata?.mediaDelivery === record.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].metadata.deliveryKind, 'failed');
  assert.match(notes[0].content, /No pude entregar la transcripción/);
});

// ── service: follow-ups ─────────────────────────────────────────────────

test('findOpenDelivery + amendDelivery fold a follow-up into the open request', async (t) => {
  const { service, state } = await harness(t, { files: [fileRow('a'), fileRow('b')] });
  const record = await service.createDelivery(request());
  assert.equal((await service.findOpenDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['a', 'b'] })).id, record.id);
  assert.equal(await service.findOpenDelivery({ userId: 'u1', chatId: 'chat1', fileIds: ['a', 'zzz'] }), null,
    'a new recording is not covered by the open request');
  assert.equal(await service.findOpenDelivery({ userId: 'u2', chatId: 'chat1', fileIds: ['a'] }), null);
  const out = await service.amendDelivery(record.id, { userId: 'u1', amendment: { goal: 'y tradúcelo al inglés', translationTarget: 'en', language: 'es' } });
  assert.equal(out.outcome, 'amended');
  assert.deepEqual(out.changes, ['translation', 'language']);
  assert.equal(state.hints.length, 2, 'the new language reaches both recordings');
  assert.match(amendedMessage({ changes: out.changes, record: out.record }), /^Anotado: cuando terminen las transcripciones te las entrego traducidas al inglés\./);
});

test('the chat copy for Stop, a follow-up and a repeated request', () => {
  assert.equal(cancelledMessage({ fileNames: ['clase.mp4'] }), 'Detuve la transcripción de «clase.mp4». Si la necesitas, pídemela de nuevo y retomo donde quedó.');
  assert.equal(amendedMessage({ changes: ['document'], record: { fileIds: ['a'], output: { documentFormat: 'docx' } } }),
    'Anotado: cuando termine la transcripción te la entrego en Word. Sigo trabajando; te aviso aquí cuando esté listo.');
  assert.match(stillRunningMessage({ fileNames: ['a.mp4', 'b.mp4'] }), /^Ya estoy transcribiendo 2 archivos/);
});

// ── the media queue: «Detener» stops the jobs ──────────────────────────

const { createMediaTranscriptionService, CANCELLED_NOTE, isUserCancelledRow, isTransientMediaError } = require('../src/services/media-transcription-queue');

function queueHarness({ rows, jobs = {} } = {}) {
  const files = new Map(rows.map(row => [row.id, { ...row }]));
  const prisma = {
    file: {
      async findFirst({ where }) {
        const row = files.get(where.id);
        return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null;
      },
      async updateMany({ where, data }) {
        const row = files.get(where.id);
        if (!row || row.userId !== where.userId || row.deletedAt) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  const removed = [];
  const queue = {
    async getJob(jobId) {
      const job = jobs[jobId];
      if (!job) return null;
      return { id: jobId, getState: async () => job.state, remove: async () => { removed.push(jobId); delete jobs[jobId]; } };
    },
    async add() { return {}; },
  };
  const service = createMediaTranscriptionService({ prisma, getQueue: () => queue, processFile: async () => ({}), logger: { info() {}, warn() {} } });
  return { service, files, removed };
}

test('cancelMediaTranscription removes the queued job and marks the row stopped', async () => {
  const { jobIdFor } = require('../src/services/media-transcription-queue');
  const jobs = { [jobIdFor('a', 'u1')]: { state: 'waiting' } };
  const { service, files, removed } = queueHarness({
    rows: [fileRow('a', { processingStage: 'uploaded' }), fileRow('b', { processingStage: 'ready', extractedText: TRANSCRIPT }),
      fileRow('x', { userId: 'u2', processingStage: 'uploaded' })],
    jobs,
  });
  const out = await service.cancelMediaTranscription({ fileIds: ['a', 'b', 'x'], userId: 'u1' });
  assert.equal(out.stopped, 1);
  assert.deepEqual(removed, [jobIdFor('a', 'u1')]);
  assert.equal(files.get('a').processingStage, 'failed');
  assert.equal(files.get('a').processingError, CANCELLED_NOTE);
  assert.equal(isUserCancelledRow(files.get('a')), true);
  assert.equal(files.get('b').processingStage, 'ready', 'a finished transcript is kept');
  assert.equal(files.get('x').processingStage, 'uploaded', 'another user\'s file is never touched');
  assert.equal(out.results.find(result => result.id === 'x').outcome, 'error');
  assert.equal(isTransientMediaError({ code: 'media_cancelled' }), false, 'a Stop is never retried by the queue');
});

test('a stopped recording resumes when the user asks for it again', async () => {
  const mediaBatch = require('../src/services/media-batch');
  const enqueued = [];
  const rows = [fileRow('a', { processingStage: 'failed', processingError: CANCELLED_NOTE })];
  const out = await mediaBatch.waitForMediaBatch({
    prisma: null, userId: 'u1', rows, timeoutMs: 0, readProgress: null,
    enqueue: async payload => { enqueued.push(payload); return { queued: true }; },
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].retry, true);
  assert.equal(out.rows[0].processingStage, 'uploaded');
});

// ── route ───────────────────────────────────────────────────────────────

test('POST /api/media-deliveries/cancel is owner-scoped and validates its input', async () => {
  const express = require('express');
  const { createMediaDeliveriesRouter } = require('../src/routes/media-deliveries');
  const calls = [];
  const fake = { cancelChatDeliveries: async args => { calls.push(args); return { cancelled: 1, results: [{ id: 'md_x', outcome: 'cancelled', messageId: 'm1', stoppedFiles: 2 }] }; } };
  const app = express();
  app.use(express.json());
  app.use('/api/media-deliveries', createMediaDeliveriesRouter({ delivery: fake, auth: (req, _res, next) => { req.user = { id: 'u1' }; next(); } }));
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/media-deliveries/cancel`;
    const post = body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ chatId: '../etc' })).status, 400);
    const res = await post({ chatId: 'chat1', deliveryIds: ['md_x', 42, '../y'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cancelled: 1, results: [{ id: 'md_x', outcome: 'cancelled', messageId: 'm1' }] });
    assert.deepEqual(calls, [{ userId: 'u1', chatId: 'chat1', deliveryIds: ['md_x'] }]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a transcription running here is aborted at once and keeps its checkpoints', async () => {
  const rows = new Map([['a', fileRow('a', { processingStage: 'uploaded', path: '/tmp/a.mp4', mimeType: 'audio/mpeg' })]]);
  const prisma = { file: {
    async findFirst({ where }) { const row = rows.get(where.id); return row && row.userId === where.userId && !row.deletedAt ? { ...row } : null; },
    async updateMany({ where, data }) { const row = rows.get(where.id); if (!row || row.userId !== where.userId) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
  } };
  const jobs = new Map();
  const queue = {
    async getJob(id) { return jobs.get(id) || null; },
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts, state: 'waiting', attemptsMade: 0, discarded: false,
        async getState() { return this.state; }, async remove() { jobs.delete(this.id); }, discard() { this.discarded = true; } };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const cleared = [];
  const service = createMediaTranscriptionService({
    prisma, getQueue: () => queue, now: () => T0, validate: async (_local, file) => file.mimeType, offload: async file => file.path,
    materialize: async source => ({ path: source, cleanup: async () => {} }),
    createCheckpoint: () => ({ clear: async () => { cleared.push('cleared'); } }),
    logger: { info() {}, warn() {} },
    processFile: (_file, { signal }) => new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await service.enqueueMediaTranscription({ fileId: 'a', userId: 'u1' });
  const job = [...jobs.values()][0];
  job.state = 'active';
  const processing = service.processMediaJob(job);
  await running;
  const out = await service.cancelMediaTranscription({ fileIds: ['a'], userId: 'u1' });
  assert.deepEqual(out.results, [{ id: 'a', outcome: 'aborted' }]);
  await assert.rejects(processing, { code: 'media_cancelled' });
  assert.equal(rows.get('a').processingStage, 'failed');
  assert.equal(rows.get('a').processingError, CANCELLED_NOTE);
  assert.equal(job.discarded, true, 'the queue does not retry a Stop');
  assert.deepEqual(cleared, [], 'its finished segments stay for the resume');
});
