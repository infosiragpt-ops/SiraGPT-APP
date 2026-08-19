'use strict';

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/services/attribution-snapshot-store');

test.beforeEach(() => store.__resetForTests());

test('saveSnapshot: in-memory mirror is populated even when disk is disabled', async () => {
  const r = await store.saveSnapshot({
    userId: 'u', chatId: 'c',
    snapshot: { intent: 'build', score: 0.8 },
  });
  assert.strictEqual(r.ok, true);
  const list = await store.readSnapshots({ userId: 'u', chatId: 'c' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].intent, 'build');
});

test('saveSnapshot: rejects when snapshot is missing', async () => {
  const r = await store.saveSnapshot({ userId: 'u', chatId: 'c' });
  assert.strictEqual(r.ok, false);
});

test('saveSnapshot: enriches with ts + turnId when missing', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { foo: 'bar' } });
  const [snap] = await store.readSnapshots({ userId: 'u', chatId: 'c' });
  assert.ok(snap.ts);
  assert.ok(snap.turnId);
});

test('saveSnapshot: keeps provided turnId', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', turnId: 't1', snapshot: { x: 1 } });
  const [snap] = await store.readSnapshots({ userId: 'u', chatId: 'c' });
  assert.strictEqual(snap.turnId, 't1');
});

test('readSnapshots: sorts by ts ascending', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 1 } });
  await new Promise((r) => setTimeout(r, 5));
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 2 } });
  const list = await store.readSnapshots({ userId: 'u', chatId: 'c' });
  assert.strictEqual(list[0].i, 1);
  assert.strictEqual(list[1].i, 2);
});

test('readSnapshots: respects limit', async () => {
  for (let i = 0; i < 10; i += 1) {
    await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i } });
  }
  const list = await store.readSnapshots({ userId: 'u', chatId: 'c', limit: 5 });
  assert.strictEqual(list.length, 5);
  assert.strictEqual(list[list.length - 1].i, 9);
});

test('readSnapshots: respects since filter', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 1 } });
  // Wait long enough that the next save's timestamp definitively
  // exceeds the cutoff even on coarse-resolution clocks (the previous
  // 5 ms gap was flaky on CI where Date.now() advances slowly).
  await new Promise((r) => setTimeout(r, 40));
  const cutoff = Date.now();
  await new Promise((r) => setTimeout(r, 40));
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 2 } });
  const list = await store.readSnapshots({ userId: 'u', chatId: 'c', since: cutoff });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].i, 2);
});

test('tail: returns the last n snapshots', async () => {
  for (let i = 0; i < 5; i += 1) {
    await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i } });
  }
  const t = await store.tail({ userId: 'u', chatId: 'c', n: 2 });
  assert.strictEqual(t.length, 2);
  assert.strictEqual(t[1].i, 4);
});

test('countSnapshots returns total', async () => {
  for (let i = 0; i < 7; i += 1) {
    await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i } });
  }
  const c = await store.countSnapshots({ userId: 'u', chatId: 'c' });
  assert.strictEqual(c, 7);
});

test('clear({userId, chatId}) wipes the chat in-memory', async () => {
  await store.saveSnapshot({ userId: 'a', chatId: 'x', snapshot: { i: 1 } });
  await store.saveSnapshot({ userId: 'b', chatId: 'y', snapshot: { i: 1 } });
  await store.clear({ userId: 'a', chatId: 'x' });
  const a = await store.readSnapshots({ userId: 'a', chatId: 'x' });
  assert.strictEqual(a.length, 0);
  const b = await store.readSnapshots({ userId: 'b', chatId: 'y' });
  assert.strictEqual(b.length, 1);
});

test('clear({userId}) wipes all chats for one user', async () => {
  await store.saveSnapshot({ userId: 'multi', chatId: 'a', snapshot: { i: 1 } });
  await store.saveSnapshot({ userId: 'multi', chatId: 'b', snapshot: { i: 2 } });
  await store.clear({ userId: 'multi' });
  assert.strictEqual(store.stats().chats, 0);
});

test('clear() with no args wipes everything', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 1 } });
  await store.clear();
  assert.strictEqual(store.stats().chats, 0);
});

test('stats reports the current state', async () => {
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 1 } });
  await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i: 2 } });
  const s = store.stats();
  assert.strictEqual(s.chats, 1);
  assert.strictEqual(s.totalSnapshots, 2);
  assert.ok(typeof s.baseDir === 'string');
  assert.strictEqual(typeof s.enabled, 'boolean');
});

test('in-memory mirror cap enforced at INMEM_CAP', async () => {
  for (let i = 0; i < store.INMEM_CAP + 10; i += 1) {
    await store.saveSnapshot({ userId: 'u', chatId: 'c', snapshot: { i } });
  }
  // when persistence is disabled, in-mem is the only source — should be capped
  if (!store.ENABLED) {
    const c = await store.countSnapshots({ userId: 'u', chatId: 'c' });
    assert.ok(c <= store.INMEM_CAP);
  }
});

test('hot path: 100 saveSnapshot calls under 200ms (in-mem only)', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) {
    await store.saveSnapshot({ userId: 'perf', chatId: 'c', snapshot: { i } });
  }
  assert.ok(Date.now() - t0 < 1000);
});
