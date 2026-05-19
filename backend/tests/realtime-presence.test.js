/**
 * Tests for services/realtime/presence.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PresenceTracker } = require('../src/services/realtime/presence');

test('presence: heartbeat marks user online and emits online once', async () => {
  const p = new PresenceTracker({ ttlMs: 1000 });
  let onlineEvents = 0;
  p.on('online', () => { onlineEvents += 1; });
  assert.equal(await p.isOnline('u1'), false);
  await p.heartbeat('u1');
  assert.equal(await p.isOnline('u1'), true);
  await p.heartbeat('u1'); // re-heartbeat
  assert.equal(onlineEvents, 1, 'online emitted exactly once for repeated heartbeats');
  p.dispose();
});

test('presence: goOffline removes user and emits offline', async () => {
  const p = new PresenceTracker({ ttlMs: 1000 });
  let offlineEvents = 0;
  p.on('offline', () => { offlineEvents += 1; });
  await p.heartbeat('u2');
  await p.goOffline('u2');
  assert.equal(await p.isOnline('u2'), false);
  assert.equal(offlineEvents, 1);
  // goOffline for absent user does not double-emit
  await p.goOffline('u2');
  assert.equal(offlineEvents, 1);
  p.dispose();
});

test('presence: TTL expires user automatically', async () => {
  const p = new PresenceTracker({ ttlMs: 30 });
  let offlineEvents = 0;
  p.on('offline', () => { offlineEvents += 1; });
  await p.heartbeat('u3');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await p.isOnline('u3'), false);
  assert.equal(offlineEvents, 1);
  p.dispose();
});

test('presence: getOnlineUsers returns snapshot', async () => {
  const p = new PresenceTracker({ ttlMs: 1000 });
  await p.heartbeat('a');
  await p.heartbeat('b');
  const list = await p.getOnlineUsers();
  const ids = list.map((x) => x.userId).sort();
  assert.deepEqual(ids, ['a', 'b']);
  for (const entry of list) {
    assert.ok(Number.isFinite(entry.lastSeenAt));
  }
  p.dispose();
});

test('presence: redis client errors fall back to in-memory', async () => {
  const fakeRedis = {
    set: async () => { throw new Error('boom'); },
    get: async () => { throw new Error('boom'); },
    del: async () => { throw new Error('boom'); },
    keys: async () => { throw new Error('boom'); },
  };
  const p = new PresenceTracker({ ttlMs: 1000, redis: fakeRedis });
  await p.heartbeat('uX');
  assert.equal(await p.isOnline('uX'), true);
  p.dispose();
});
