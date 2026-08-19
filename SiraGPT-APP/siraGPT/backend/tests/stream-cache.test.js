'use strict';

/**
 * Phase 8E.3 — regression coverage for the quick-lru-backed stream cache.
 *
 * The previous Map+reaper implementation had no unit coverage. These
 * tests lock the contract that the SSE chat handler relies on:
 *  - the handle returned by start() mutates the same entry that resume()
 *    sees, so a tab reload mid-stream pulls partial content
 *  - complete() / fail() flip the snapshot status without dropping the
 *    accumulated content
 *  - forget() removes the entry on demand
 *  - the LRU honors maxSize so a runaway producer cannot fill memory
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const streamCache = require('../src/services/stream-cache');

test.beforeEach(async () => { await streamCache._reset(); });

test('start + append + resume returns the partial snapshot', async () => {
  const handle = await streamCache.start('u1', 'c1', { title: 'hi' });
  handle.append('hola ');
  handle.append('mundo');
  const snap = await streamCache.resume('u1', 'c1');
  assert.equal(snap.status, 'streaming');
  assert.equal(snap.content, 'hola mundo');
  assert.equal(snap.title, 'hi');
  assert.equal(snap.error, null);
});

test('complete flips status to done and preserves content', async () => {
  const handle = await streamCache.start('u1', 'c1');
  handle.append('parcial');
  handle.complete();
  const snap = await streamCache.resume('u1', 'c1');
  assert.equal(snap.status, 'done');
  assert.equal(snap.content, 'parcial');
});

test('fail flips status to error and records the message', async () => {
  const handle = await streamCache.start('u1', 'c1');
  handle.append('parcial');
  handle.fail('upstream timeout');
  const snap = await streamCache.resume('u1', 'c1');
  assert.equal(snap.status, 'error');
  assert.equal(snap.error, 'upstream timeout');
  assert.equal(snap.content, 'parcial');
});

test('resume returns null for an unknown chat', async () => {
  const snap = await streamCache.resume('ghost', 'never-started');
  assert.equal(snap, null);
});

test('forget evicts the entry so a subsequent resume is null', async () => {
  const handle = await streamCache.start('u1', 'c1');
  handle.append('something');
  handle.forget();
  const snap = await streamCache.resume('u1', 'c1');
  assert.equal(snap, null);
});

test('append after forget re-creates the entry under sliding TTL', async () => {
  const handle = await streamCache.start('u1', 'c1');
  handle.append('part-1');
  handle.forget();
  // The handle still has a closure over the cache; appending after a
  // forget re-inserts the entry. This matches the existing behavior so
  // late writers do not silently drop chunks.
  handle.append('part-2');
  const snap = await streamCache.resume('u1', 'c1');
  assert.equal(snap.content, 'part-1part-2');
});

test('two distinct chats are isolated by composite key', async () => {
  const a = await streamCache.start('u1', 'chatA');
  const b = await streamCache.start('u1', 'chatB');
  a.append('A');
  b.append('B');
  assert.equal((await streamCache.resume('u1', 'chatA')).content, 'A');
  assert.equal((await streamCache.resume('u1', 'chatB')).content, 'B');
});

test('cache size never exceeds the configured maxSize under bulk load', async () => {
  // Default cap is 1000. We push twice that with distinct chats and
  // verify the LRU evicts oldest, not crashes nor grows unbounded.
  for (let i = 0; i < 2200; i++) {
    const h = await streamCache.start(`u${i}`, `chat${i}`);
    h.append('x');
  }
  const size = await streamCache._size();
  assert.ok(size <= 1000, `size ${size} should be capped at 1000`);
});
