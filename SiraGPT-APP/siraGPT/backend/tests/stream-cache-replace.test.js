const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const streamCache = require('../src/services/stream-cache');

beforeEach(() => {
  streamCache._reset();
});

test('stream cache replaces content when a corrected SSE frame arrives', () => {
  const handle = streamCache.start('user-1', 'chat-1');
  handle.append('respuesta debil');
  handle.replace('respuesta corregida');
  handle.complete();

  const snapshot = streamCache.resume('user-1', 'chat-1');
  assert.equal(snapshot.status, 'done');
  assert.equal(snapshot.content, 'respuesta corregida');
});
