/**
 * Tests for services/realtime/cursor-sharing.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CursorThrottler, DEFAULT_THROTTLE_MS } = require('../src/services/realtime/cursor-sharing');

test('cursor: throttle constant exported', () => {
  assert.equal(DEFAULT_THROTTLE_MS, 50);
});

test('cursor: first submission emitted immediately', () => {
  const seen = [];
  let now = 1000;
  const c = new CursorThrottler({
    broadcast: (p) => seen.push(p),
    now: () => now,
    throttleMs: 50,
  });
  const r = c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 1, y: 2 } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data, { x: 1, y: 2 });
  assert.ok(r);
  c.dispose();
});

test('cursor: rapid updates within throttle window are coalesced', async () => {
  const seen = [];
  const c = new CursorThrottler({
    broadcast: (p) => seen.push(p),
    throttleMs: 30,
  });
  // First fires immediately
  c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 1, y: 1 } });
  // Two more within window — only last should be trailing-flushed
  c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 2, y: 2 } });
  c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 3, y: 3 } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].data, { x: 3, y: 3 });
  c.dispose();
});

test('cursor: selection:update validates {anchor, head}', () => {
  const seen = [];
  const c = new CursorThrottler({ broadcast: (p) => seen.push(p), throttleMs: 50 });
  c.submit({ chatId: 'c', userId: 'u', type: 'selection:update', data: { anchor: 0, head: 12 } });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].data, { anchor: 0, head: 12 });
  assert.throws(
    () => c.submit({ chatId: 'c', userId: 'u', type: 'selection:update', data: { anchor: 'x' } }),
    /invalid payload/,
  );
  assert.throws(
    () => c.submit({ chatId: 'c', userId: 'u', type: 'mystery', data: {} }),
    /unknown cursor event/,
  );
  c.dispose();
});

test('cursor: clear drops pending state without firing', async () => {
  const seen = [];
  const c = new CursorThrottler({ broadcast: (p) => seen.push(p), throttleMs: 30 });
  c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 1, y: 1 } });
  c.submit({ chatId: 'c', userId: 'u', type: 'cursor:update', data: { x: 9, y: 9 } });
  c.clear('c', 'u');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seen.length, 1, 'trailing flush cancelled by clear');
  c.dispose();
});
