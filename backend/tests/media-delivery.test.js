'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const delivery = require('../src/services/media-delivery');
const { createMediaDeliveryStore } = require('../src/services/media-delivery-store');

const {
  createMediaDeliveryService, isMediaDeliveryEnabled, inlineWaitMs, estimateTranscriptionSeconds,
  estimateBatchEtaSeconds, shouldHandOff, handOffMessage, deliveryMessage, notificationCopy,
  deliveryFailureCopy, classifyFileRow, formatApproxDuration, defaultBuildArtifacts, TRANSCRIPTION_RTF,
} = delivery;

const T0 = Date.parse('2026-10-15T10:00:00Z');
const MIN = 60 * 1000;
const ENABLED = { SIRAGPT_MEDIA_DELIVERY: '1' };
const TRANSCRIPT = 'Buenos días a todos. Hoy hablamos de la mitocondria.\n\nLa mitocondria produce energía para la célula.';

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sira-delivery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fileRow(id, extra = {}) {
  return { id, userId: 'u1', originalName: `${id}.mp4`, filename: `${id}.mp4`, mimeType: 'video/mp4',
    processingStage: 'extracting', processingError: null, extractedText: null, deletedAt: null, ...extra };
}

function ready(id, extra = {}) {
  return fileRow(id, { processingStage: 'ready', extractedText: TRANSCRIPT, ...extra });
}

/** Fakes for every side effect; `state` records what happened. */
async function harness(t, { files = [], chats = ['chat1'], transcripts = {}, env = ENABLED, overrides = {}, clockStart = T0 } = {}) {
  const root = await tempRoot(t);
  const clock = { t: clockStart };
  const now = () => clock.t;
  const state = {
    files: new Map(files.map(row => [row.id, { ...row }])),
    chats: new Set(chats),
    messages: [],
    notifications: [],
    saved: [],
    persisted: [],
    loads: [],
    created: [],
    findFirst: [],
    built: 0,
  };
  // Honours the JSON path filters like PostgreSQL: `metadata` and every `AND` entry must match.
  const metadataFilters = where => [where.metadata, ...(Array.isArray(where.AND) ? where.AND.map(clause => clause.metadata) : [])]
    .filter(Boolean);
  const prisma = {
    message: {
      async findFirst({ where }) {
        state.findFirst.push(where);
        const filters = metadataFilters(where);
        const found = state.messages.find(m => m.chatId === where.chatId
          && filters.every(filter => m.metadata?.[filter.path[0]] === filter.equals));
        return found ? { id: found.id, chatId: found.chatId } : null;
      },
    },
  };
  const deps = {
    env,
    now,
    prisma,
    logger: { info() {}, warn() {} },
    store: createMediaDeliveryStore({ root, now }),
    loadFiles: async (userId, ids, opts) => {
      state.loads.push({ userId, ids, opts });
      return ids.map(id => state.files.get(id)).filter(row => row && row.userId === userId && !row.deletedAt).map(row => ({ ...row }));
    },
    loadTranscript: async (_prisma, { fileId }) => transcripts[fileId] || null,
    buildArtifacts: async ({ rows }) => {
      state.built++;
      return [{ filename: 'clase-transcripcion.txt', base64: Buffer.from(rows.map(r => r.extractedText || '').join('\n')).toString('base64'), mime: 'text/plain' }];
    },
    saveArtifact: ({ filename, mime, ownerUserId, chatId }) => {
      const artifact = { id: `art${state.saved.length + 1}`, filename, format: filename.split('.').pop(), mime,
        ownerUserId, chatId, downloadUrl: `/api/agent/artifact/art${state.saved.length + 1}` };
      state.saved.push(artifact);
      return artifact;
    },
    persistArtifact: async args => { state.persisted.push(args); },
    postMessage: async ({ userId, chatId, content, metadata, artifacts }) => {
      if (!state.chats.has(chatId)) throw Object.assign(new Error('chat missing'), { code: 'chat_unavailable' });
      const message = { id: `msg${state.messages.length + 1}`, userId, chatId, content, metadata, artifacts };
      state.messages.push(message);
      return { messageId: message.id, chatId };
    },
    ensureChat: async ({ userId, chatId, title, model }) => {
      if (chatId && state.chats.has(chatId)) return { chatId, created: false };
      const id = `chat_new_${state.created.length + 1}`;
      state.created.push({ id, userId, title, model });
      state.chats.add(id);
      return { chatId: id, created: true };
    },
    notify: async payload => { state.notifications.push(payload); },
    analyze: null,
    ...overrides,
  };
  const service = createMediaDeliveryService(deps);
  return { service, state, clock, root, deps, store: deps.store };
}

function newDelivery(extra = {}) {
  return { userId: 'u1', chatId: 'chat1', taskId: 'task1', fileIds: ['clase'], fileNames: ['clase.mp4'],
    goal: 'transcribe este video', mode: 'transcript', formats: ['txt'], model: { id: 'deepseek-v4-flash', provider: 'DeepSeek' }, ...extra };
}

// ── kill switch ────────────────────────────────────────────────────────

test('kill switch: SIRAGPT_MEDIA_DELIVERY=0 disables creation, hooks and hand-off', async (t) => {
  assert.equal(isMediaDeliveryEnabled({ SIRAGPT_MEDIA_DELIVERY: '0' }), false);
  assert.equal(isMediaDeliveryEnabled({ SIRAGPT_MEDIA_DELIVERY: 'off' }), false);
  assert.equal(isMediaDeliveryEnabled({ SIRAGPT_MEDIA_DELIVERY: '1', NODE_ENV: 'test' }), true);
  assert.equal(isMediaDeliveryEnabled({}), true, 'default on in production');
  assert.equal(isMediaDeliveryEnabled({ NODE_ENV: 'test' }), false, 'test suites opt in');
  const { service, state, root } = await harness(t, { files: [ready('clase')], env: { SIRAGPT_MEDIA_DELIVERY: '0' } });
  assert.equal(await service.createDelivery(newDelivery()), null);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await service.onMediaTerminal({ fileId: 'clase', userId: 'u1' })).status, 'disabled');
  assert.equal((await service.sweepPendingDeliveries()).status, 'disabled');
  assert.equal((await service.deliverOne('md_00000000-0000-4000-8000-000000000000')).status, 'disabled');
  assert.equal(shouldHandOff({ etaSeconds: null, pendingCount: 1, env: { SIRAGPT_MEDIA_DELIVERY: '0' } }), false);
  assert.equal(state.messages.length, 0);
});

// ── delivery lifecycle ─────────────────────────────────────────────────

test('terminal → delivered once: waits while pending, posts message, artifacts and notification', async (t) => {
  const { service, state, store } = await harness(t, { files: [fileRow('clase')] });
  const record = await service.createDelivery(newDelivery());
  assert.match(record.id, /^md_/);

  const waiting = await service.onMediaTerminal({ fileId: 'clase', userId: 'u1' });
  assert.equal(waiting.matched, 1);
  assert.equal(waiting.results[0].status, 'waiting');
  assert.deepEqual(state.loads[0].opts, { includeText: false }, 'status probe never loads transcripts');
  assert.equal(state.messages.length, 0);
  const afterWait = await store.get(record.id);
  assert.equal(afterWait.status, 'pending');
  assert.equal(afterWait.attempts, 0, 'waiting is not a failed attempt');
  assert.deepEqual(afterWait, record, 'a waiting record is neither claimed nor rewritten');

  Object.assign(state.files.get('clase'), { processingStage: 'ready', extractedText: TRANSCRIPT });
  const done = await service.onMediaTerminal({ fileId: 'clase', userId: 'u1' });
  assert.equal(done.results[0].status, 'delivered');
  assert.equal(state.messages.length, 1);
  const [message] = state.messages;
  assert.equal(message.chatId, 'chat1');
  assert.equal(message.metadata.mediaDelivery, record.id);
  assert.deepEqual(message.metadata.transcriptionFileIds, ['clase']);
  assert.equal(message.metadata.servedBy, 'media_batch');
  assert.equal(message.metadata.taskId, 'task1');
  assert.equal(message.metadata.stoppedReason, 'transcription_finalize');
  assert.match(message.content, /\*\*Tu transcripción de «clase\.mp4» está lista\.\*\*/);
  assert.match(message.content, /mitocondria/);
  assert.match(message.content, /\*\*Descargas:\*\* clase-transcripcion\.txt/);
  assert.equal(message.artifacts.length, 1);
  assert.equal(state.saved[0].chatId, 'chat1');
  assert.equal(state.saved[0].ownerUserId, 'u1');
  assert.deepEqual(state.persisted.map(p => [p.artifact.id, p.messageId, p.chatId, p.taskId]), [['art1', 'msg1', 'chat1', 'task1']]);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].title, 'Tu transcripción de «clase.mp4» está lista');
  assert.equal(state.notifications[0].actionUrl, '/agentes?id=chat1');
  assert.equal(state.notifications[0].userId, 'u1');
  const final = await store.get(record.id);
  assert.equal(final.status, 'delivered');
  assert.equal(final.deliveredMessageId, 'msg1');

  // Later hooks and sweeps are no-ops.
  assert.equal((await service.onMediaTerminal({ fileId: 'clase', userId: 'u1' })).matched, 0);
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.equal(state.messages.length, 1);
  assert.equal(state.notifications.length, 1);
});

test('running twice never posts twice (same process and two processes)', async (t) => {
  const { service, state, deps, store } = await harness(t, { files: [ready('clase')] });
  const record = await service.createDelivery(newDelivery());
  // Second "process": its own service over the same delivery directory.
  const other = createMediaDeliveryService({ ...deps, store: createMediaDeliveryStore({ root: store.root, now: deps.now }) });
  const results = await Promise.all([
    service.deliverOne(record.id), service.deliverOne(record.id), other.deliverOne(record.id),
    service.onMediaTerminal({ fileId: 'clase', userId: 'u1' }), other.sweepPendingDeliveries(),
  ]);
  assert.equal(state.messages.length, 1);
  assert.equal(state.notifications.length, 1);
  assert.ok(results.some(result => result.status === 'delivered'));
  await service.deliverOne(record.id);
  await other.sweepPendingDeliveries();
  assert.equal(state.messages.length, 1);
});

test('idempotency: an existing message with the delivery id is adopted, not duplicated', async (t) => {
  const { service, state, store } = await harness(t, { files: [ready('clase')] });
  const record = await service.createDelivery(newDelivery());
  // Simulate a crash after the post and before the record was marked.
  state.messages.push({ id: 'msg_prev', chatId: 'chat1', content: 'x', metadata: { source: 'media-delivery', mediaDelivery: record.id } });
  const result = await service.deliverOne(record.id);
  assert.equal(result.status, 'already_delivered');
  assert.equal(result.messageId, 'msg_prev');
  assert.equal(state.messages.length, 1);
  assert.equal(state.notifications.length, 0);
  assert.equal(state.built, 0, 'no artifacts rebuilt');
  assert.deepEqual(state.findFirst[0], { chatId: 'chat1', AND: [
    { metadata: { path: ['mediaDelivery'], equals: record.id } },
    { metadata: { path: ['source'], equals: 'media-delivery' } },
  ] });
  const final = await store.get(record.id);
  assert.equal(final.status, 'delivered');
  assert.equal(final.deliveredMessageId, 'msg_prev');
});

test('the turn\'s «te aviso aquí» message naming the delivery never counts as delivered', async (t) => {
  const { service, state, store } = await harness(t, { files: [ready('clase')] });
  const record = await service.createDelivery(newDelivery());
  // The hand-off the agent-task runner persisted in the same chat: both the
  // old key and the new one, written with the runner's own source.
  state.messages.push(
    { id: 'msg_handoff', chatId: 'chat1', content: 'Recibí «clase.mp4»… te aviso aquí',
      metadata: { source: 'agent-task', mediaDelivery: record.id, stoppedReason: 'media_delivery_handoff' } },
    { id: 'msg_handoff2', chatId: 'chat1', content: 'Recibí «clase.mp4»… te aviso aquí',
      metadata: { source: 'agent-task', mediaDeliveryHandoff: record.id } },
  );
  const result = await service.deliverOne(record.id);
  assert.equal(result.status, 'delivered');
  assert.equal(state.messages.length, 3);
  const posted = state.messages[2];
  assert.equal(posted.metadata.source, 'media-delivery');
  assert.equal(posted.metadata.mediaDelivery, record.id);
  assert.match(posted.content, /Tu transcripción de «clase\.mp4» está lista/);
  assert.equal(state.notifications.length, 1);
  assert.equal((await store.get(record.id)).deliveredMessageId, posted.id);
  // Its own message is then recognised: a later run adopts it.
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  assert.equal(state.messages.length, 3);
});

test('deleted chat → a new «Transcripción: …» chat receives the result', async (t) => {
  const { service, state, store } = await harness(t, { files: [ready('clase')], chats: [] });
  const record = await service.createDelivery(newDelivery());
  const result = await service.deliverOne(record.id);
  assert.equal(result.status, 'delivered');
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].title, 'Transcripción: clase.mp4');
  assert.equal(state.created[0].model, 'deepseek-v4-flash');
  assert.equal(state.messages[0].chatId, 'chat_new_1');
  assert.equal(state.saved[0].chatId, 'chat_new_1');
  assert.equal(state.notifications[0].actionUrl, '/agentes?id=chat_new_1');
  assert.equal((await store.get(record.id)).deliveryChatId, 'chat_new_1');
});

test('a retry after a failed post reuses the replacement chat instead of creating another', async (t) => {
  let fail = true;
  const h = await harness(t, { files: [ready('clase')], chats: [], overrides: {
    postMessage: async ({ chatId, content, metadata }) => {
      if (fail) { fail = false; throw new Error('db down'); }
      const message = { id: 'msgX', chatId, content, metadata };
      h.state.messages.push(message);
      return { messageId: 'msgX', chatId };
    },
  } });
  const record = await h.service.createDelivery(newDelivery());
  assert.equal((await h.service.deliverOne(record.id)).status, 'retry');
  assert.equal((await h.store.get(record.id)).deliveryChatId, 'chat_new_1');
  h.clock.t += MIN;
  assert.equal((await h.service.deliverOne(record.id)).status, 'delivered');
  assert.equal(h.state.created.length, 1, 'one replacement chat only');
  assert.equal(h.state.messages[0].chatId, 'chat_new_1');
  assert.equal((await h.store.get(record.id)).attempts, 1);
});

test('partial transcription → the message names the missing time ranges', async (t) => {
  const partialRow = ready('clase', { processingError: 'Parcial: 2 de 30 tramos fallaron. Reintentar recupera solo esos tramos' });
  const { service, state } = await harness(t, {
    files: [partialRow],
    transcripts: { clase: { durationSec: 18120, language: 'es', coverage: 0.93, gaps: [{ start: 4800, end: 5400, reason: 'timeout' }, { start: 9600, end: 10200 }] } },
  });
  const record = await service.createDelivery(newDelivery());
  await service.deliverOne(record.id);
  const content = state.messages[0].content;
  assert.match(content, /terminó parcialmente/);
  assert.match(content, /Faltan estos tramos: 01:20:00–01:30:00 y 02:40:00–02:50:00\./);
  assert.match(content, /5 h 2 min · español · .* palabras · cobertura 93 %/);
  assert.match(content, /Escribe «reintenta» en este chat para recuperar solo lo que falta/);
  assert.equal(state.messages[0].metadata.stoppedReason, 'media_batch_partial');
  assert.equal(state.notifications[0].title, 'Tu transcripción de «clase.mp4» terminó parcialmente');
  assert.equal(state.notifications[0].type, 'media_transcription_partial');
});

test('partial without a segments sidecar falls back to the stored reason', async () => {
  const content = deliveryMessage({ delivery: newDelivery(), rows: [ready('clase', { processingError: 'Parcial: 1 de 30 tramos fallaron. Reintentar recupera solo esos tramos' })] });
  assert.match(content, /No se pudieron transcribir algunos tramos \(1 de 30 tramos fallaron\)\./);
});

test('failed file → failure copy with the reason and a retry hint, no artifacts', async (t) => {
  const { service, state } = await harness(t, { files: [fileRow('clase', { processingStage: 'failed', processingError: 'No se pudo leer el audio. Comprueba que el archivo no esté dañado.' })] });
  const record = await service.createDelivery(newDelivery());
  await service.deliverOne(record.id);
  const content = state.messages[0].content;
  assert.match(content, /\*\*No pude transcribir «clase\.mp4»\.\*\*/);
  assert.match(content, /Motivo: No se pudo leer el audio/);
  assert.match(content, /intentarlo de nuevo sin volver a subir el archivo/);
  assert.doesNotMatch(content, /Descargas/);
  assert.equal(state.built, 0);
  assert.equal(state.messages[0].metadata.stoppedReason, 'media_batch_failed');
  assert.equal(state.notifications[0].title, 'No pude transcribir «clase.mp4»');
});

test('a deleted file counts as failed instead of blocking the delivery', async (t) => {
  const { service, state } = await harness(t, { files: [ready('a'), ready('gone', { deletedAt: new Date() })] });
  const record = await service.createDelivery(newDelivery({ fileIds: ['a', 'gone'], fileNames: ['a.mp4', 'gone.mp4'] }));
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  const content = state.messages[0].content;
  assert.match(content, /Terminé con tus 2 archivos: 1 completo, 1 con error\./);
  assert.match(content, /«gone\.mp4»: no se pudo transcribir \(El archivo ya no está disponible\.\)/);
  assert.equal(state.notifications[0].title, 'Tus transcripciones terminaron (1 de 2 completas)');
});

test('delivery failing 5 times → terminal failed + «No pude entregar» notification', async (t) => {
  const h = await harness(t, { files: [ready('clase')], overrides: {
    postMessage: async () => { throw Object.assign(new Error('database unavailable'), { code: 'P1001' }); },
  } });
  const record = await h.service.createDelivery(newDelivery());
  const backoffs = [1, 5, 15, 60];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await h.service.sweepPendingDeliveries();
    assert.equal(result.attempted, 1);
    assert.equal(result.results[0].status, 'retry');
    const stored = await h.store.get(record.id);
    assert.equal(stored.attempts, attempt);
    assert.match(stored.lastError, /P1001/);
    // Still in backoff: neither the sweep nor the hook retries early.
    h.clock.t += backoffs[attempt - 1] * MIN - 1000;
    assert.equal((await h.service.sweepPendingDeliveries()).attempted, 0);
    assert.equal((await h.service.deliverOne(record.id)).status, 'backoff');
    h.clock.t += 1000;
  }
  assert.equal(h.state.notifications.length, 0, 'no notification per attempt');
  const last = await h.service.sweepPendingDeliveries();
  assert.equal(last.results[0].status, 'failed');
  const stored = await h.store.get(record.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.attempts, 5);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].title, 'No pude entregar la transcripción');
  assert.equal(h.state.notifications[0].body,
    'No pude entregar la transcripción de «clase.mp4». Tus archivos y su transcripción siguen guardados; escribe "reintenta" en el chat.');
  assert.equal(h.state.notifications[0].actionUrl, '/agentes?id=chat1');
  h.clock.t += 24 * 60 * MIN;
  assert.equal((await h.service.sweepPendingDeliveries()).attempted, 0);
  assert.equal(h.state.messages.length, 0);
});

test('the give-up notification links the replacement chat created by an earlier attempt', async (t) => {
  const h = await harness(t, { files: [ready('clase')], chats: [], overrides: {
    maxAttempts: 2,
    postMessage: async () => { throw new Error('db down'); },
  } });
  const record = await h.service.createDelivery(newDelivery());
  assert.equal((await h.service.deliverOne(record.id)).status, 'retry');
  h.clock.t += MIN;
  assert.equal((await h.service.deliverOne(record.id)).status, 'failed');
  assert.equal(h.state.created.length, 1);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].actionUrl, '/agentes?id=chat_new_1');
  assert.equal(h.state.notifications[0].type, 'media_transcription_delivery_failed');
});

test('a notification failure after posting never re-posts', async (t) => {
  const h = await harness(t, { files: [ready('clase')], overrides: { notify: async () => { throw new Error('push down'); } } });
  const record = await h.service.createDelivery(newDelivery());
  assert.equal((await h.service.deliverOne(record.id)).status, 'delivered');
  assert.equal((await h.store.get(record.id)).status, 'delivered');
  await h.service.sweepPendingDeliveries();
  assert.equal(h.state.messages.length, 1);
});

test('the reconcile sweep recovers a delivery whose terminal hook was missed', async (t) => {
  const { service, state } = await harness(t, { files: [ready('clase')] });
  const record = await service.createDelivery(newDelivery());
  // The media job finished while this process was down: no hook ran.
  const sweep = await service.sweepPendingDeliveries();
  assert.equal(sweep.scanned, 1);
  assert.equal(sweep.delivered, 1);
  assert.equal(state.messages[0].metadata.mediaDelivery, record.id);
});

test('the sweep rotates so waiting records never starve the ones behind them', async (t) => {
  const { service, state, store } = await harness(t, { files: [ready('a'), ready('b')], overrides: { maxPerSweep: 1 } });
  const first = await service.createDelivery(newDelivery({ fileIds: ['a'], fileNames: ['a.mp4'] }));
  const second = await service.createDelivery(newDelivery({ fileIds: ['b'], fileNames: ['b.mp4'] }));
  // Whichever record sorts first keeps waiting on its file.
  const [waitingRecord, readyRecord] = first.id < second.id ? [first, second] : [second, first];
  Object.assign(state.files.get(waitingRecord.fileIds[0]), { processingStage: 'extracting', extractedText: null });
  const pass1 = await service.sweepPendingDeliveries();
  assert.deepEqual(pass1.results.map(r => [r.id, r.status]), [[waitingRecord.id, 'waiting']]);
  const pass2 = await service.sweepPendingDeliveries();
  assert.deepEqual(pass2.results.map(r => [r.id, r.status]), [[readyRecord.id, 'delivered']]);
  const pass3 = await service.sweepPendingDeliveries();
  assert.deepEqual(pass3.results.map(r => [r.id, r.status]), [[waitingRecord.id, 'waiting']]);
  assert.equal((await store.get(readyRecord.id)).status, 'delivered');
  assert.equal(state.messages.length, 1);
});

test('shutdown during delivery reverts the record to pending without spending an attempt', async (t) => {
  let release;
  let entered;
  const enteredBuild = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { files: [ready('clase')], overrides: {
    buildArtifacts: async () => {
      entered();
      await new Promise(resolve => { release = resolve; });
      return [{ filename: 'clase-transcripcion.txt', base64: 'eA==', mime: 'text/plain' }];
    },
  } });
  const record = await h.service.createDelivery(newDelivery());
  const running = h.service.deliverOne(record.id);
  await enteredBuild;
  assert.equal((await h.store.get(record.id)).status, 'delivering');
  const closed = await h.service.close({ graceMs: 10 });
  assert.equal(closed.released, 1);
  const reverted = await h.store.get(record.id);
  assert.equal(reverted.status, 'pending');
  assert.equal(reverted.attempts, 0);
  await assert.rejects(fs.stat(path.join(h.store.root, `${record.id}.lock`)), { code: 'ENOENT' });
  release();
  assert.equal((await running).status, 'closing');
  assert.equal(h.state.messages.length, 0);
  assert.equal((await h.store.get(record.id)).attempts, 0);
  assert.equal((await h.service.deliverOne(record.id)).status, 'closing');
  // The next process picks it up immediately (no stale wait).
  const next = createMediaDeliveryService({ ...h.deps, store: createMediaDeliveryStore({ root: h.store.root, now: h.deps.now }),
    buildArtifacts: async () => [{ filename: 'clase-transcripcion.txt', base64: 'eA==', mime: 'text/plain' }] });
  assert.equal((await next.deliverOne(record.id)).status, 'delivered');
  assert.equal(h.state.messages.length, 1);
});

test('analysis mode: the requested analysis replaces the preview; a failed analysis is reported honestly', async (t) => {
  const calls = [];
  const ok = await harness(t, { files: [ready('clase')], overrides: {
    analyze: async ({ rows, delivery: rec }) => { calls.push({ ids: rows.map(r => r.id), goal: rec.goal, model: rec.model }); return { text: 'Resumen: la clase trató la mitocondria.' }; },
  } });
  const record = await ok.service.createDelivery(newDelivery({ mode: 'analysis', goal: 'transcribe y resume la clase' }));
  await ok.service.deliverOne(record.id);
  assert.deepEqual(calls, [{ ids: ['clase'], goal: 'transcribe y resume la clase', model: { id: 'deepseek-v4-flash', provider: 'DeepSeek' } }]);
  assert.match(ok.state.messages[0].content, /### Análisis\n\nResumen: la clase trató la mitocondria\./);
  assert.doesNotMatch(ok.state.messages[0].content, /### (Vista previa|Transcripción)/);

  const bad = await harness(t, { files: [ready('clase')], overrides: { analyze: async () => { throw Object.assign(new Error('quota'), { code: 'media_analysis_plan_quota_exhausted' }); } } });
  const second = await bad.service.createDelivery(newDelivery({ mode: 'analysis' }));
  assert.equal((await bad.service.deliverOne(second.id)).status, 'delivered');
  assert.match(bad.state.messages[0].content, /No pude terminar el análisis que pediste/);
  assert.match(bad.state.messages[0].content, /### Transcripción/);
});

test('files still pending past the ceiling are delivered as pending', async (t) => {
  const { service, state, clock } = await harness(t, { files: [ready('a'), fileRow('b')] });
  const record = await service.createDelivery(newDelivery({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'] }));
  assert.equal((await service.deliverOne(record.id)).status, 'waiting');
  clock.t += 24 * 60 * MIN;
  assert.equal((await service.deliverOne(record.id)).status, 'delivered');
  const content = state.messages[0].content;
  assert.match(content, /1 completo, 1 pendiente/);
  assert.match(content, /«b\.mp4»: sigue en la cola/);
  assert.match(content, /continúa transcribiéndose/);
});

test('onMediaTerminal only touches the owner\'s deliveries and rejects bad ids', async (t) => {
  const { service, state } = await harness(t, { files: [ready('clase')] });
  await service.createDelivery(newDelivery({ userId: 'u2' }));
  const result = await service.onMediaTerminal({ fileId: 'clase', userId: 'u1' });
  assert.equal(result.matched, 0);
  assert.equal(state.messages.length, 0);
  assert.equal((await service.deliverOne('../../etc/passwd')).status, 'invalid');
  assert.equal((await service.deliverOne('md_00000000-0000-4000-8000-000000000000')).status, 'missing');
  await assert.rejects(service.createDelivery({ userId: 'u1', fileIds: [] }), { code: 'invalid_record' });
});

test('default chat + message writers: ownership check, agent-task envelope, chat touched', async (t) => {
  const writes = { chatCreate: [], messageCreate: [], chatUpdate: [] };
  const prisma = {
    chat: {
      async findFirst({ where }) { return where.id === 'chat_new' && where.userId === 'u1' ? { id: 'chat_new' } : null; },
      async create({ data }) { writes.chatCreate.push(data); return { id: 'chat_new' }; },
      async update(args) { writes.chatUpdate.push(args); return {}; },
    },
    message: {
      async findFirst() { return null; },
      async create({ data }) { writes.messageCreate.push(data); return { id: 'm1' }; },
    },
  };
  const h = await harness(t, { files: [ready('clase')], overrides: { prisma, ensureChat: undefined, postMessage: undefined } });
  const record = await h.service.createDelivery(newDelivery({ chatId: 'deleted_chat' }));
  const result = await h.service.deliverOne(record.id);
  assert.equal(result.status, 'delivered');
  assert.equal(writes.chatCreate.length, 1);
  assert.deepEqual(writes.chatCreate[0], { userId: 'u1', title: 'Transcripción: clase.mp4', model: 'deepseek-v4-flash' });
  const msg = writes.messageCreate[0];
  assert.equal(msg.chatId, 'chat_new');
  assert.equal(msg.role, 'ASSISTANT');
  assert.match(msg.content, /^```agent-task-state\n/);
  const envelope = JSON.parse(msg.content.split('\n')[1]);
  assert.equal(envelope.done, true);
  assert.equal(envelope.artifacts[0].id, 'art1');
  assert.match(envelope.finalText, /Tu transcripción de «clase\.mp4» está lista/);
  assert.equal(msg.metadata.source, 'media-delivery');
  assert.equal(msg.metadata.mediaDelivery, record.id);
  assert.equal(msg.metadata.servedBy, 'media_batch');
  assert.deepEqual(writes.chatUpdate.map(u => u.where.id), ['chat_new']);
});

// ── pure helpers ───────────────────────────────────────────────────────

test('estimateTranscriptionSeconds table', () => {
  assert.deepEqual(TRANSCRIPTION_RTF, { local: 0.15, 'local-turbo': 0.9, cloud: 0.02 });
  const fiveHours = 5 * 3600;
  const cases = [
    [{ durationSec: fiveHours }, 30 + 108 + 2700],
    [{ durationSec: fiveHours, engine: 'whisper.cpp' }, 2838],
    [{ durationSec: fiveHours, engine: 'local', parallel: 3 }, 30 + 108 + 900],
    [{ durationSec: fiveHours, engine: 'openai' }, 30 + 108 + 360],
    [{ durationSec: fiveHours, engine: 'groq', parallel: 4 }, 498],
    [{ durationSec: 3600, engine: 'local-turbo', parallel: 2 }, Math.ceil(30 + 21.6 + 1620)],
    [{ durationSec: 600 }, Math.ceil(30 + 3.6 + 90)],
    [{ durationSec: null }, null],
    [{ durationSec: 0 }, null],
    [{ durationSec: -5 }, null],
    [{ durationSec: 'n/a' }, null],
    [{}, null],
  ];
  for (const [args, expected] of cases) assert.equal(estimateTranscriptionSeconds(args), expected, JSON.stringify(args));
});

test('estimateBatchEtaSeconds uses live ETAs, progress and durations', () => {
  assert.equal(estimateBatchEtaSeconds({ files: [{ state: 'ready' }] }), 0);
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { etaSeconds: 600 } }] }), 600);
  assert.equal(estimateBatchEtaSeconds({ files: [{ durationSec: 600, progress: { percent: 50 } }] }), Math.ceil(124 * 0.5));
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { etaSeconds: 600 } }, { durationSec: null }] }), null);
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { etaSeconds: 600 } }, { progress: { etaSeconds: 600 } }, { progress: { etaSeconds: 600 } }] }), 900);
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { etaSeconds: 1000 } }, { progress: { etaSeconds: 10 } }] }), 1000);
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { stage: 'preparing', percent: 1, etaSeconds: null, durationSeconds: 18000 } }] }),
    Math.ceil(2838 * 0.99));
  assert.equal(estimateBatchEtaSeconds({ files: [{ progress: { stage: 'preparing', etaSeconds: null, durationSeconds: 0 } }] }), null);
});

test('shouldHandOff table (TRANSCRIBE_CHAT_INLINE_WAIT_MS default 240000)', () => {
  assert.equal(inlineWaitMs({}), 240000);
  assert.equal(inlineWaitMs({ TRANSCRIBE_CHAT_INLINE_WAIT_MS: '600000' }), 600000);
  assert.equal(inlineWaitMs({ TRANSCRIBE_CHAT_INLINE_WAIT_MS: 'x' }), 240000);
  assert.equal(inlineWaitMs({ TRANSCRIBE_CHAT_INLINE_WAIT_MS: '0' }), 0);
  const env = ENABLED;
  const cases = [
    [{ etaSeconds: 3000, pendingCount: 0, env }, false],
    [{ etaSeconds: null, pendingCount: 1, env }, true],
    [{ etaSeconds: undefined, pendingCount: 2, env }, true],
    [{ etaSeconds: NaN, pendingCount: 1, env }, true],
    [{ etaSeconds: 100, pendingCount: 1, env }, false],
    [{ etaSeconds: 240, pendingCount: 1, env }, false],
    [{ etaSeconds: 241, pendingCount: 1, env }, true],
    [{ etaSeconds: 2838, pendingCount: 1, env }, true],
    [{ etaSeconds: 300, pendingCount: 1, env: { ...env, TRANSCRIBE_CHAT_INLINE_WAIT_MS: '600000' } }, false],
    [{ etaSeconds: 1, pendingCount: 1, env: { ...env, TRANSCRIBE_CHAT_INLINE_WAIT_MS: '0' } }, true],
    [{ etaSeconds: 9999, pendingCount: 1, env: { SIRAGPT_MEDIA_DELIVERY: '0' } }, false],
  ];
  for (const [args, expected] of cases) assert.equal(shouldHandOff(args), expected, JSON.stringify(args));
});

test('handOffMessage: one file, several files, unknown duration and ETA', () => {
  assert.equal(handOffMessage({ fileNames: ['clase.mp4'], durationSec: 18000, etaSeconds: 2838 }),
    'Recibí «clase.mp4» (≈5 h). La transcripción tarda ~47 min; te aviso aquí y en notificaciones cuando termine. Puedes seguir usando el chat.');
  assert.equal(handOffMessage({ fileNames: ['a.mp3', 'b.mp3', 'c.mp3'], durationSec: 5 * 3600 + 20 * 60, etaSeconds: 2 * 3600 + 600 }),
    'Recibí 3 archivos («a.mp3», «b.mp3» y «c.mp3»; ≈5 h 20 min en total). Las transcripciones tardan ~2 h 10 min; te aviso aquí y en notificaciones cuando terminen. Puedes seguir usando el chat.');
  assert.match(handOffMessage({ fileNames: ['a', 'b', 'c', 'd', 'e'], etaSeconds: 600 }), /Recibí 5 archivos \(«a», «b», «c» y 2 más\)\./);
  assert.equal(handOffMessage({ fileNames: ['clase.webm'] }),
    'Recibí «clase.webm». Todavía no sé cuánto tardará la transcripción; te aviso aquí y en notificaciones cuando termine. Puedes seguir usando el chat.');
  assert.match(handOffMessage({ fileNames: ['x.mp3'], durationSec: 600, etaSeconds: 30 }), /\(≈10 min\)\. La transcripción tardará menos de 2 min;/);
  assert.match(handOffMessage({}), /^Recibí tu archivo\. Todavía no sé/);
  assert.equal(formatApproxDuration(18000), '≈5 h');
  assert.equal(formatApproxDuration(18000 + 7 * 60), '≈5 h 5 min');
  assert.equal(formatApproxDuration(45 * 60), '≈45 min');
  assert.equal(formatApproxDuration(20), 'menos de 1 min');
  assert.equal(formatApproxDuration(null), '');
});

test('classifyFileRow: ready, partial, failed, pending', () => {
  assert.equal(classifyFileRow(ready('a')), 'ready');
  assert.equal(classifyFileRow(ready('a', { processingError: 'Parcial: 1 de 30 tramos fallaron.' })), 'partial');
  assert.equal(classifyFileRow(fileRow('a', { processingStage: 'failed' })), 'failed');
  assert.equal(classifyFileRow(fileRow('a', { processingStage: 'ready', extractedText: '' })), 'failed');
  assert.equal(classifyFileRow(fileRow('a', { processingStage: 'uploaded' })), 'pending');
  assert.equal(classifyFileRow(null), 'failed');
});

test('deliveryMessage: escaping, preview cut, missing formats, range', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Párrafo ${i} con *énfasis* y [enlace](http://x) de la clase.`).join('\n\n');
  const content = deliveryMessage({
    delivery: newDelivery({ formats: ['txt', 'docx', 'srt'], range: { start: 90, end: 600 } }),
    rows: [ready('clase', { extractedText: long })],
    artifacts: [{ filename: 'clase-transcripcion.txt', format: 'txt' }],
  });
  assert.match(content, /### Vista previa/);
  assert.match(content, /_Vista previa\. Descarga el archivo adjunto para leer la transcripción completa\._/);
  assert.match(content, /\\\*énfasis\\\*/);
  assert.match(content, /\\\[enlace\\\]/);
  assert.doesNotMatch(content, /Párrafo 199/);
  assert.match(content, /No pude generar Word \(DOCX\) ni subtítulos SRT; te dejo la transcripción en TXT\./);
  assert.match(content, /Tramo pedido: 01:30–10:00\./);
  const short = deliveryMessage({ delivery: newDelivery(), rows: [ready('clase')], artifacts: [] });
  assert.match(short, /### Transcripción\n\nBuenos días/);
  assert.doesNotMatch(short, /Vista previa/);
});

test('notification and failure copy for several files', () => {
  const rows = [ready('a'), ready('b'), ready('c')];
  assert.equal(notificationCopy({ delivery: {}, rows }).title, 'Tus transcripciones están listas (3 archivos)');
  assert.equal(notificationCopy({ delivery: {}, rows: [fileRow('a', { processingStage: 'failed' }), fileRow('b', { processingStage: 'failed' })] }).title,
    'No pude transcribir tus 2 archivos');
  assert.equal(deliveryFailureCopy({ delivery: { fileNames: ['a.mp3', 'b.mp3', 'c.mp3'] } }).body,
    'No pude entregar la transcripción de «a.mp3» y 2 más. Tus archivos y su transcripción siguen guardados; escribe "reintenta" en el chat.');
});

test('default artifact builder: TXT always, SRT/VTT from the segments sidecar', async () => {
  const rows = [ready('clase', { originalName: 'Clase de biología.mp4' })];
  rows[0].deliveryState = 'ready';
  const transcripts = { clase: { segments: [{ s: 0, e: 2.5, t: 'Buenos días.' }, { s: 3700, e: 3702, t: 'Hasta luego.' }] } };
  const artifacts = await defaultBuildArtifacts({ rows, transcripts, delivery: newDelivery({ formats: ['txt', 'srt', 'vtt'] }) });
  assert.deepEqual(artifacts.map(a => [a.filename, a.mime]), [
    ['Clase-de-biologia-transcripcion.txt', 'text/plain'],
    ['Clase-de-biologia.srt', 'application/x-subrip'],
    ['Clase-de-biologia.vtt', 'text/vtt'],
  ]);
  const srt = Buffer.from(artifacts[1].base64, 'base64').toString('utf8');
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500\nBuenos días\./);
  assert.match(srt, /01:01:40,000 --> 01:01:42,000\nHasta luego\./);
  assert.match(Buffer.from(artifacts[2].base64, 'base64').toString('utf8'), /^WEBVTT/);
  assert.match(Buffer.from(artifacts[0].base64, 'base64').toString('utf8'), /^Clase de biología\.mp4\n=+\nBuenos días/);
  assert.deepEqual(await defaultBuildArtifacts({ rows: [fileRow('x', { processingStage: 'failed' })], delivery: newDelivery() }), []);
  const multi = await defaultBuildArtifacts({ rows: [ready('a'), ready('b', { processingError: 'Parcial: 1 de 3 tramos fallaron.' })], delivery: newDelivery() });
  assert.equal(multi[0].filename, 'transcripciones-completas.txt');
  assert.match(Buffer.from(multi[0].base64, 'base64').toString('utf8'), /2\. b\.mp4\n=+\n\[Transcripción parcial: 1 de 3 tramos fallaron\]/);
});

// ── ranges and the recording clock (the chat agrees with the downloads) ──

/** A sidecar of `minutes` of speech starting at `from` s, one segment a minute. */
function sidecar({ from = 0, minutes = 300, gaps = [], coverage = 0.97, extra = {} } = {}) {
  const segments = [];
  for (let m = 0; m < minutes; m++) {
    const s = from + m * 60;
    segments.push({ s, e: s + 50, t: `Minuto ${m}: explicamos el tema número ${m}.` });
  }
  return { durationSec: minutes * 60, language: 'es', coverage, gaps, segments, ...extra };
}

/** The stored File text: «[hh:mm:ss] …» paragraphs from 00:00:00 (or `from`). */
function storedText({ from = 0, minutes = 300 } = {}) {
  return Array.from({ length: minutes }, (_, m) => `[${formatClock(from + m * 60)}] Minuto ${m}: explicamos el tema número ${m}.`).join('\n\n');
}

const { formatClock } = delivery;
const PARTIAL = 'Parcial: 3 de 30 tramos fallaron. Reintentar recupera solo esos tramos';

test('a requested range: the preview, gaps and coverage are those of the window, not of the recording', () => {
  const transcript = sidecar({ gaps: [{ start: 600, end: 900 }, { start: 2000, end: 2100 }, { start: 9000, end: 9600 }] });
  const row = ready('clase', { extractedText: storedText(), processingError: PARTIAL });
  const content = deliveryMessage({ delivery: newDelivery({ range: { start: 1800, end: 2700 } }), rows: [row], transcripts: { clase: transcript } });
  assert.match(content, /Tramo pedido: 30:00–45:00\./);
  assert.match(content, /Faltan este tramo: 33:20–35:00\./, 'only the gap inside the window');
  assert.doesNotMatch(content, /10:00–15:00|02:30:00/, 'gaps outside the window are not listed');
  assert.match(content, /cobertura 88 %/, 'coverage of the window (100 s missing of 900 s)');
  assert.match(content, /Minuto 30: explicamos/);
  assert.doesNotMatch(content, /Minuto 0: explicamos/, 'the preview starts at the window, not at 00:00:00');
  assert.doesNotMatch(content, /Minuto 50: explicamos/);
  // The window itself is complete although the recording is not.
  const whole = deliveryMessage({ delivery: newDelivery({ range: { start: 3600, end: 4200 } }), rows: [row], transcripts: { clase: transcript } });
  assert.match(whole, /El tramo que pediste está completo; faltan otros tramos de la grabación\./);
  const batch = deliveryMessage({ delivery: newDelivery({ range: { start: 3600, end: 4200 } }),
    rows: [row, ready('b')], transcripts: { clase: transcript } });
  assert.match(batch, /«clase\.mp4»: tramo pedido completo \(faltan otros tramos de la grabación\)/);
});

test('a requested range outside the recording is never called complete nor given the recording coverage', () => {
  // 5 h partial recording; «del minuto 333 al 350» lies past its end.
  const transcript = sidecar({ gaps: [{ start: 600, end: 900 }, { start: 9000, end: 9600 }], coverage: 0.95 });
  const row = ready('clase', { extractedText: storedText(), processingError: PARTIAL });
  const past = newDelivery({ range: { start: 20000, end: 21000 } });
  const content = deliveryMessage({ delivery: past, rows: [row], transcripts: { clase: transcript } });
  assert.doesNotMatch(content, /está completo/);
  assert.doesNotMatch(content, /cobertura/);
  assert.match(content, /El tramo que pediste \(05:33:20–05:50:00\) queda fuera de la grabación, que dura 5 h\./);
  const batch = deliveryMessage({ delivery: past, rows: [row, ready('b')], transcripts: { clase: transcript } });
  assert.doesNotMatch(batch, /tramo pedido completo|cobertura/);
  assert.match(batch, /«clase\.mp4»: el tramo pedido queda fuera de la grabación, que dura 5 h/);
  // An open window past the end, too.
  const open = deliveryMessage({ delivery: newDelivery({ range: { start: 19000, end: null } }), rows: [row], transcripts: { clase: transcript } });
  assert.match(open, /El tramo que pediste \(desde 05:16:40\) queda fuera de la grabación/);
  assert.doesNotMatch(open, /está completo|cobertura/);
  // A clip stored on the recording clock: a window before its offset is outside it.
  const clip = sidecar({ from: 3600, minutes: 30, gaps: [{ start: 4200, end: 4500 }], coverage: 0.83, extra: { timeOffsetSec: 3600 } });
  clip.durationSec = 1800;
  const clipRow = ready('tramo', { extractedText: storedText({ from: 3600, minutes: 30 }), processingError: PARTIAL });
  const before = deliveryMessage({ delivery: newDelivery({ range: { start: 0, end: 600 } }), rows: [clipRow], transcripts: { tramo: clip } });
  assert.doesNotMatch(before, /está completo|cobertura/);
  assert.match(before, /El tramo que pediste \(00:00:00–00:10:00\) queda fuera del tramo transcrito de la grabación \(01:00:00–01:30:00\)\./);
  // A ready file says it too instead of only «(Sin voz transcrita en este tramo.)».
  const whole = ready('entera', { extractedText: storedText() });
  const readyMsg = deliveryMessage({ delivery: past, rows: [whole], transcripts: { entera: sidecar({ coverage: 1 }) } });
  assert.match(readyMsg, /queda fuera de la grabación, que dura 5 h\./);
  // A window that overlaps the recording keeps the «complete window» copy.
  const inside = deliveryMessage({ delivery: newDelivery({ range: { start: 3600, end: 4200 } }), rows: [row], transcripts: { clase: transcript } });
  assert.match(inside, /El tramo que pediste está completo; faltan otros tramos de la grabación\./);
});

test('a clip offset: preview and gaps follow the recording clock like the attachments', () => {
  const clip = sidecar({ minutes: 30, gaps: [{ start: 600, end: 900 }] });
  const row = ready('tramo', { extractedText: storedText({ minutes: 30 }), processingError: PARTIAL });
  const content = deliveryMessage({ delivery: newDelivery({ output: { timeOffsetSec: 3600 } }), rows: [row], transcripts: { tramo: clip } });
  assert.match(content, /Faltan este tramo: 01:10:00–01:15:00\./);
  assert.match(content, /\\\[01:00:00\\\] Minuto 0: explicamos/, 'escaped «[hh:mm:ss]» on the recording clock');
  assert.doesNotMatch(content, /\[00:00(:00)?\\?\] Minuto 0/);
});

test('a transcript the queue already stored on the recording clock is never shifted twice', () => {
  const stored = sidecar({ from: 3600, minutes: 30, gaps: [{ start: 4200, end: 4500 }], extra: { timeOffsetSec: 3600 } });
  const row = ready('tramo', { extractedText: storedText({ from: 3600, minutes: 30 }), processingError: PARTIAL });
  for (const output of [{ timeOffsetSec: 0 }, { timeOffsetSec: 3600 }]) {
    const content = deliveryMessage({ delivery: newDelivery({ output }), rows: [row], transcripts: { tramo: stored } });
    assert.match(content, /Faltan este tramo: 01:10:00–01:15:00\./, JSON.stringify(output));
    assert.match(content, /\\\[01:00:00\\\] Minuto 0: explicamos/);
    assert.doesNotMatch(content, /02:00:00|02:10:00/);
  }
});

// ── translation mode: the transcript files and the analysis that were asked for ──

test('«transcribe y tradúcelo»: the transcript files come with the translation; a failed translation still delivers them', async (t) => {
  const translated = { text: 'Hello everyone.', artifacts: [{ filename: 'clase (traducción al inglés).txt', base64: 'eA==', mime: 'text/plain' }] };
  const both = await harness(t, { files: [ready('clase')], overrides: { analyze: async () => translated } });
  const record = await both.service.createDelivery(newDelivery({ mode: 'translation', goal: 'transcribe este video y tradúcelo al inglés',
    output: { includeTranscript: true } }));
  assert.equal((await both.service.deliverOne(record.id)).status, 'delivered');
  assert.equal(both.state.built, 1, 'the transcript pack is built');
  assert.deepEqual(both.state.saved.map(a => a.filename), ['clase-transcripcion.txt', 'clase (traducción al inglés).txt']);
  assert.match(both.state.messages[0].content, /### Traducción\n\nHello everyone\./);

  const alone = await harness(t, { files: [ready('clase')], overrides: { analyze: async () => translated } });
  const only = await alone.service.createDelivery(newDelivery({ mode: 'translation', goal: 'tradúcelo al inglés' }));
  await alone.service.deliverOne(only.id);
  assert.equal(alone.state.built, 0, 'a translation follow-up does not re-send the transcript');

  const failing = await harness(t, { files: [ready('clase')], overrides: { analyze: async () => { throw new Error('provider down'); } } });
  const failed = await failing.service.createDelivery(newDelivery({ mode: 'translation', goal: 'tradúcelo al inglés' }));
  assert.equal((await failing.service.deliverOne(failed.id)).status, 'delivered');
  assert.equal(failing.state.built, 1, 'the transcript is all there is to deliver');
  const content = failing.state.messages[0].content;
  assert.match(content, /No pude terminar la traducción que pediste/);
  assert.match(content, /\*\*Descargas:\*\* clase-transcripcion\.txt/);
});

test('«resume y tradúcelo» delivers the summary with the translation; a failed file is named', async (t) => {
  const h = await harness(t, { files: [ready('a'), ready('b')], overrides: {
    analyze: async () => ({ text: '#### «a.mp4»\n\nHello everyone.', summary: 'Resumen: la clase trató la mitocondria.',
      failed: [{ id: 'b', name: 'b.mp4' }], notes: ['No pude generar el Word de la traducción; el TXT la tiene completa.'],
      artifacts: [{ filename: 'a (traducción al inglés).txt', base64: 'eA==', mime: 'text/plain' }] }),
  } });
  const record = await h.service.createDelivery(newDelivery({ fileIds: ['a', 'b'], fileNames: ['a.mp4', 'b.mp4'], mode: 'translation',
    goal: 'resume y tradúcelo al inglés', output: { alsoAnalysis: true } }));
  await h.service.deliverOne(record.id);
  const content = h.state.messages[0].content;
  assert.match(content, /### Análisis\n\nResumen: la clase trató la mitocondria\.\n\n### Traducción\n\n#### «a\.mp4»\n\nHello everyone\./);
  assert.match(content, /No pude traducir «b\.mp4»\. Su transcripción sigue guardada; vuelve a pedirme la traducción/);
  assert.match(content, /No pude generar el Word de la traducción/);

  const noSummary = await harness(t, { files: [ready('clase')], overrides: { analyze: async () => ({ text: 'Hello.', artifacts: [] }) } });
  const second = await noSummary.service.createDelivery(newDelivery({ mode: 'translation', goal: 'resume y tradúcelo al inglés', output: { alsoAnalysis: true } }));
  await noSummary.service.deliverOne(second.id);
  assert.match(noSummary.state.messages[0].content, /No pude terminar el análisis que pediste/);
  assert.match(noSummary.state.messages[0].content, /### Traducción\n\nHello\./);
});

// ── concurrency ────────────────────────────────────────────────────────

test('the sweep skips a delivery already running in this process instead of waiting for it', async (t) => {
  let release;
  let entered;
  const enteredBuild = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { files: [ready('clase')], overrides: {
    buildArtifacts: async () => {
      entered();
      await new Promise(resolve => { release = resolve; });
      return [{ filename: 'clase-transcripcion.txt', base64: 'eA==', mime: 'text/plain' }];
    },
  } });
  const record = await h.service.createDelivery(newDelivery());
  const running = h.service.deliverOne(record.id);
  await enteredBuild;
  let timer;
  const blocked = new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 1000); });
  const sweep = await Promise.race([h.service.sweepPendingDeliveries(), blocked]);
  clearTimeout(timer);
  assert.notEqual(sweep, 'blocked', 'the sweep must not wait for the running delivery');
  assert.equal(sweep.attempted, 0);
  release();
  assert.equal((await running).status, 'delivered');
  assert.equal(h.state.messages.length, 1);
});

test('a delivery whose lock was reclaimed meanwhile does not post', async (t) => {
  let stolen = null;
  const h = await harness(t, { files: [ready('clase')], overrides: {
    buildArtifacts: async () => {
      // This process stalled past the stale window; another one took over.
      h.clock.t += 16 * MIN;
      stolen = await createMediaDeliveryStore({ root: h.store.root, now: h.deps.now }).claim(record.id);
      return [{ filename: 'clase-transcripcion.txt', base64: 'eA==', mime: 'text/plain' }];
    },
  } });
  const record = await h.service.createDelivery(newDelivery());
  const result = await h.service.deliverOne(record.id);
  assert.ok(stolen, 'the other process holds the lock');
  assert.equal(result.status, 'lock_lost');
  assert.equal(h.state.messages.length, 0);
  assert.equal(h.state.notifications.length, 0);
});

test('fallback Word render: a unique working copy that is removed afterwards', async (t) => {
  const dir = await tempRoot(t);
  const names = [];
  const createDocument = async (userId, filename, markdown) => {
    names.push(filename);
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, markdown);
    return { filePath };
  };
  const rows = [Object.assign(ready('clase'), { deliveryState: 'ready' })];
  const [first, second] = await Promise.all([1, 2].map(() => defaultBuildArtifacts({ rows, transcripts: {},
    delivery: newDelivery({ formats: ['txt', 'docx'] }), createDocument })));
  for (const built of [first, second]) {
    assert.deepEqual(built.map(a => a.filename), ['clase-transcripcion.txt', 'clase-transcripcion.docx']);
    assert.match(Buffer.from(built[1].base64, 'base64').toString('utf8'), /mitocondria/);
  }
  assert.equal(new Set(names).size, 2, 'each render gets its own working name');
  assert.ok(names.every(name => /^transcript-[0-9a-f-]{36}\.docx$/.test(name)));
  assert.deepEqual(await fs.readdir(dir), [], 'no working copy left behind');
});
