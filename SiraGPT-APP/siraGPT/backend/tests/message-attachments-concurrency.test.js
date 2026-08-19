'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapWithLimit } = require('../src/services/message-attachments');

test('mapWithLimit returns empty array when input is empty', async () => {
  const out = await mapWithLimit([], async () => 1);
  assert.deepEqual(out, []);
});

test('mapWithLimit fast-paths single-item arrays without dynamic import', async () => {
  const out = await mapWithLimit([42], async (n) => n * 2);
  assert.deepEqual(out, [84]);
});

test('mapWithLimit preserves input order regardless of completion order', async () => {
  const items = [10, 20, 30, 40, 50];
  const out = await mapWithLimit(items, async (n) => {
    await new Promise((r) => setTimeout(r, 50 - n / 2));
    return n + 1;
  }, 3);
  assert.deepEqual(out, [11, 21, 31, 41, 51]);
});

test('mapWithLimit caps active concurrency at the configured limit', async () => {
  const limit = 2;
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 8 }, (_, i) => i);
  const out = await mapWithLimit(items, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 25));
    active -= 1;
    return n;
  }, limit);
  assert.deepEqual(out, items);
  assert.ok(peak <= limit, `peak concurrency ${peak} exceeded limit ${limit}`);
});

test('mapWithLimit propagates rejections from the worker', async () => {
  await assert.rejects(
    () => mapWithLimit([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }, 2),
    /boom/,
  );
});
