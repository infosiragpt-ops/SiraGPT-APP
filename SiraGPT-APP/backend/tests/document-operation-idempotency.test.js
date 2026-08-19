'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryIdempotencyStore } = require('../src/middleware/idempotency');
const {
  beginDocumentOperation,
  inspectDocumentOperation,
  buildDocumentReplayFrame,
} = require('../src/services/document-operation-idempotency');

function begin(store, overrides = {}) {
  return beginDocumentOperation({
    store,
    userId: 'user-1',
    route: 'doc.generate',
    key: 'edit-request-123',
    body: { prompt: 'cambia el título a 2027', format: 'docx' },
    ...overrides,
  });
}

test('concurrent document requests with the same key execute only once', async () => {
  const store = createInMemoryIdempotencyStore();
  const [first, duplicate] = await Promise.all([begin(store), begin(store)]);
  assert.equal(first.outcome, 'acquired');
  assert.equal(duplicate.outcome, 'in_progress');
  await first.fail();
});

test('a completed document operation replays the original SSE final contract without file bytes', async () => {
  const store = createInMemoryIdempotencyStore();
  const first = await begin(store);
  assert.equal(first.outcome, 'acquired');
  await first.complete({
    chatId: 'chat-1',
    assistantMessageId: 'message-1',
    content: 'Documento editado y validado.',
    format: 'docx',
    file: {
      id: 'artifact-1',
      filename: 'informe-editado.docx',
      format: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 1200,
      downloadUrl: '/api/agent/artifact/artifact-1',
      dataUrl: 'data:application/octet-stream;base64,SECRET-BYTES',
    },
  });

  const replay = await begin(store);
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.result.file.downloadUrl, '/api/agent/artifact/artifact-1');
  assert.equal('dataUrl' in replay.result.file, false, 'idempotency storage must not duplicate document bytes');

  const frame = buildDocumentReplayFrame(replay.result);
  assert.deepEqual(Object.keys(frame).sort(), [
    'assistantMessage', 'content', 'file', 'format', 'replayed', 'type',
  ]);
  assert.equal(frame.type, 'final');
  assert.equal(frame.replayed, true);
  assert.equal(frame.content, 'Documento editado y validado.');
  assert.equal(frame.file.id, 'artifact-1');
  assert.equal(frame.format, 'docx');
  assert.equal(frame.assistantMessage.id, 'message-1');
});

test('idempotency keys are scoped by user/body and failed attempts are retryable', async () => {
  const store = createInMemoryIdempotencyStore();
  const first = await begin(store);
  assert.equal(first.outcome, 'acquired');

  const conflict = await begin(store, { body: { prompt: 'otra edición', format: 'docx' } });
  assert.equal(conflict.outcome, 'conflict');

  const otherUser = await begin(store, { userId: 'user-2' });
  assert.equal(otherUser.outcome, 'acquired', 'another user must have an independent key namespace');

  await first.fail();
  const retry = await begin(store);
  assert.equal(retry.outcome, 'acquired');
  await Promise.all([otherUser.fail(), retry.fail()]);
});

test('a data-URL-only artifact is never cached as a broken replay', async () => {
  const store = createInMemoryIdempotencyStore();
  const first = await begin(store);
  assert.equal(first.outcome, 'acquired');
  const cached = await first.complete({
    content: 'Documento generado.',
    format: 'docx',
    file: {
      filename: 'temporal.docx',
      format: 'docx',
      dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AA==',
    },
  });
  assert.equal(cached, false, 'non-durable artifacts must release the key instead of caching an unusable replay');

  const retry = await begin(store);
  assert.equal(retry.outcome, 'acquired');
  await retry.fail();
});

test('a failed durable-store write releases the in-flight claim', async () => {
  const backing = createInMemoryIdempotencyStore();
  let rejectPut = true;
  const store = {
    ...backing,
    async putIfLease(...args) {
      if (rejectPut) return false;
      return backing.putIfLease(...args);
    },
  };
  const first = await begin(store);
  assert.equal(first.outcome, 'acquired');
  const stored = await first.complete({
    content: 'listo',
    file: { id: 'a1', downloadUrl: '/api/agent/artifact/a1', filename: 'a.docx' },
  });
  assert.equal(stored, false);

  const retry = await begin(store);
  assert.equal(retry.outcome, 'acquired');
  rejectPut = false;
  await retry.fail();
});

test('an expired lease holder cannot overwrite or release the newer retry', async () => {
  let clock = 1_000;
  const store = createInMemoryIdempotencyStore({ now: () => clock });
  const first = await begin(store, { lockMs: 50 });
  assert.equal(first.outcome, 'acquired');

  clock += 51;
  const second = await begin(store, { lockMs: 50 });
  assert.equal(second.outcome, 'acquired');

  const staleStored = await first.complete({
    content: 'resultado obsoleto',
    file: { id: 'old', downloadUrl: '/api/agent/artifact/old', filename: 'old.docx' },
  });
  assert.equal(staleStored, false);
  const stillRunning = await begin(store, { lockMs: 50 });
  assert.equal(stillRunning.outcome, 'in_progress', 'stale completion/release must preserve the newer lease');

  assert.equal(await second.complete({
    content: 'resultado nuevo',
    file: { id: 'new', downloadUrl: '/api/agent/artifact/new', filename: 'new.docx' },
  }), true);
  const replay = await begin(store, { lockMs: 50 });
  assert.equal(replay.outcome, 'replay');
  assert.equal(replay.result.file.id, 'new');
});

test('read-only inspection exposes a completed replay before quota admission', async () => {
  const store = createInMemoryIdempotencyStore();
  const first = await begin(store);
  await first.complete({
    content: 'listo',
    file: { id: 'replay-1', downloadUrl: '/api/agent/artifact/replay-1', filename: 'r.docx' },
  });
  const inspected = await inspectDocumentOperation({
    store,
    userId: 'user-1',
    route: 'doc.generate',
    key: 'edit-request-123',
    body: { prompt: 'cambia el título a 2027', format: 'docx' },
  });
  assert.equal(inspected.outcome, 'replay');
  assert.equal(inspected.result.file.id, 'replay-1');
});

test('unsafe idempotency keys are rejected before they can reach a response header', async () => {
  const store = createInMemoryIdempotencyStore();
  const result = await begin(store, { key: 'unsafe\r\nX-Injected: yes' });
  assert.equal(result.outcome, 'invalid_key');
  assert.equal(store._size(), 0);
});
