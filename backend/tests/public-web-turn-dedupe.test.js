'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPublicWebTurnDedupe,
} = require('../src/services/ai/public-web-turn-dedupe');

const base = {
  userId: 'user-1',
  streamId: 'stream-1',
  query: '¿puedes leer https://www.tesis20.com?',
  provider: 'OpenRouter',
  model: 'deepseek-v4',
};

test('same user + stream + query shares one in-flight Promise and settled result', async () => {
  const dedupe = createPublicWebTurnDedupe();
  const owner = dedupe.acquire(base);
  const reconnect = dedupe.acquire(base);

  assert.equal(owner.owner, true);
  assert.equal(reconnect.owner, false);
  assert.equal(reconnect.entry.promise, owner.entry.promise);

  const result = { content: 'Tesis20 sí es accesible', sources: ['https://www.tesis20.com/'] };
  owner.entry.resolve(result);
  assert.equal(await reconnect.entry.promise, result);
  assert.equal(dedupe.acquire(base).owner, false);
});

test('dedupe key is namespaced by user, stable stream and query', () => {
  const dedupe = createPublicWebTurnDedupe();
  const owner = dedupe.acquire(base);
  assert.equal(owner.owner, true);

  assert.equal(dedupe.acquire({ ...base, userId: 'user-2' }).owner, true);
  assert.equal(dedupe.acquire({ ...base, streamId: 'stream-2' }).owner, true);
  assert.equal(dedupe.acquire({ ...base, query: 'otra consulta' }).owner, true);
  assert.equal(dedupe.acquire({
    ...base,
    provider: 'fallback-provider',
    model: 'fallback-model',
  }).owner, false);
});

test('failed turns are removed so a later retry can become owner', async () => {
  const dedupe = createPublicWebTurnDedupe();
  const owner = dedupe.acquire(base);
  const waiter = dedupe.acquire(base);
  const failure = new Error('provider unavailable');

  owner.entry.reject(failure);
  await assert.rejects(waiter.entry.promise, /provider unavailable/);
  assert.equal(dedupe.acquire(base).owner, true);
});

test('settled entries expire before new capacity is allocated', () => {
  let timestamp = 1_000;
  const dedupe = createPublicWebTurnDedupe({
    ttlMs: 10,
    maxEntries: 2,
    now: () => timestamp,
  });
  const first = dedupe.acquire(base);
  first.entry.resolve({ content: 'one' });
  const second = dedupe.acquire({ ...base, streamId: 'stream-2' });
  second.entry.resolve({ content: 'two' });
  assert.equal(dedupe.size(), 2);

  assert.throws(
    () => dedupe.acquire({ ...base, streamId: 'stream-3' }),
    { code: 'public_web_turn_capacity', status: 503 },
  );

  timestamp += 11;
  assert.equal(dedupe.acquire({ ...base, streamId: 'stream-3' }).owner, true);
  assert.equal(dedupe.size(), 1);
});

test('capacity pressure never evicts an in-flight owner', () => {
  const dedupe = createPublicWebTurnDedupe({ maxEntries: 2 });
  const first = dedupe.acquire(base);
  dedupe.acquire({ ...base, streamId: 'stream-2' });

  assert.throws(
    () => dedupe.acquire({ ...base, streamId: 'stream-3' }),
    { code: 'public_web_turn_capacity', status: 503 },
  );
  assert.equal(dedupe.acquire(base).entry.promise, first.entry.promise);
});

test('capacity pressure never evicts an unexpired settled replay', async () => {
  const dedupe = createPublicWebTurnDedupe({ maxEntries: 2 });
  const first = dedupe.acquire(base);
  first.entry.resolve({ content: 'cached result' });
  dedupe.acquire({ ...base, streamId: 'stream-2' });

  assert.throws(
    () => dedupe.acquire({ ...base, streamId: 'stream-3' }),
    { code: 'public_web_turn_capacity', status: 503 },
  );
  const replay = dedupe.acquire(base);
  assert.equal(replay.owner, false);
  assert.deepEqual(await replay.entry.promise, { content: 'cached result' });
});

test('elapsed wall-clock time never creates a second in-flight owner', () => {
  let timestamp = 1_000;
  const dedupe = createPublicWebTurnDedupe({
    now: () => timestamp,
  });
  const first = dedupe.acquire(base);

  timestamp += 60_000;
  const reconnect = dedupe.acquire(base);

  assert.equal(reconnect.owner, false);
  assert.equal(reconnect.entry.promise, first.entry.promise);
});
