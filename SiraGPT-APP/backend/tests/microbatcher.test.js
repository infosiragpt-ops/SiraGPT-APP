'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createMicrobatcher,
  MicrobatcherShapeError,
} = require('../src/services/ai-product-os/microbatcher');

describe('createMicrobatcher — construction', () => {
  test('rejects missing run', () => {
    assert.throws(() => createMicrobatcher({}), TypeError);
  });

  test('exposes config in snapshot', () => {
    const mb = createMicrobatcher({ run: async (xs) => xs, maxBatchSize: 4, maxLatencyMs: 10 });
    const s = mb.snapshot();
    assert.equal(s.maxBatchSize, 4);
    assert.equal(s.maxLatencyMs, 10);
  });
});

describe('createMicrobatcher — coalescing', () => {
  test('flushes when maxBatchSize reached', async () => {
    let calls = 0;
    const mb = createMicrobatcher({
      run: async (xs) => { calls += 1; return xs.map((x) => x * 2); },
      maxBatchSize: 3,
      maxLatencyMs: 10_000, // very large; size should win
    });
    const ps = [mb.submit(1), mb.submit(2), mb.submit(3)];
    const results = await Promise.all(ps);
    assert.deepEqual(results, [2, 4, 6]);
    assert.equal(calls, 1);
  });

  test('flushes after maxLatencyMs even with one item', async () => {
    let flushed = false;
    const mb = createMicrobatcher({
      run: async (xs) => { flushed = true; return xs; },
      maxBatchSize: 100,
      maxLatencyMs: 20,
    });
    const r = await mb.submit('only');
    assert.equal(r, 'only');
    assert.equal(flushed, true);
  });

  test('manual flush coalesces buffered items', async () => {
    let calls = 0;
    const mb = createMicrobatcher({
      run: async (xs) => { calls += 1; return xs; },
      maxBatchSize: 100,
      maxLatencyMs: 100_000,
    });
    const p1 = mb.submit('a');
    const p2 = mb.submit('b');
    await mb.flush('manual');
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, 'a');
    assert.equal(b, 'b');
    assert.equal(calls, 1);
  });
});

describe('createMicrobatcher — fail-loud semantics', () => {
  test('runner rejection propagates to every caller in the batch', async () => {
    const mb = createMicrobatcher({
      run: async () => { throw new Error('upstream down'); },
      maxBatchSize: 3,
      maxLatencyMs: 5,
    });
    const ps = [mb.submit(1), mb.submit(2), mb.submit(3)];
    const settled = await Promise.allSettled(ps);
    assert.ok(settled.every((s) => s.status === 'rejected'));
    assert.equal(settled[0].reason.message, 'upstream down');
  });

  test('runner returning wrong array length surfaces shape error', async () => {
    const mb = createMicrobatcher({
      run: async () => [1, 2], // returns 2 instead of expected 3
      maxBatchSize: 3,
      maxLatencyMs: 5,
    });
    const ps = [mb.submit(1), mb.submit(2), mb.submit(3)];
    const settled = await Promise.allSettled(ps);
    assert.ok(settled.every((s) => s.status === 'rejected'));
    assert.ok(settled[0].reason instanceof MicrobatcherShapeError);
  });

  test('runner returning non-array surfaces shape error', async () => {
    const mb = createMicrobatcher({
      run: async () => 'oops',
      maxBatchSize: 1,
    });
    await assert.rejects(mb.submit(1), MicrobatcherShapeError);
  });
});

describe('createMicrobatcher — onFlush sink', () => {
  test('fires with size and reason on success', async () => {
    const events = [];
    const mb = createMicrobatcher({
      run: async (xs) => xs,
      maxBatchSize: 2,
      onFlush: (e) => events.push({ size: e.size, reason: e.reason }),
    });
    await Promise.all([mb.submit(1), mb.submit(2)]);
    assert.equal(events[0].size, 2);
    assert.equal(events[0].reason, 'size');
  });

  test('fires with error attached on failure', async () => {
    const events = [];
    const mb = createMicrobatcher({
      run: async () => { throw new Error('x'); },
      maxBatchSize: 1,
      onFlush: (e) => events.push(e),
    });
    await mb.submit(1).catch(() => {});
    assert.equal(events[0].error.message, 'x');
  });

  test('throwing onFlush is swallowed', async () => {
    const mb = createMicrobatcher({
      run: async (xs) => xs,
      onFlush: () => { throw new Error('sink bad'); },
    });
    const r = await mb.submit('ok');
    assert.equal(r, 'ok');
  });
});

describe('createMicrobatcher — snapshot accounting', () => {
  test('totalFlushes / totalItems / avgBatchSize', async () => {
    const mb = createMicrobatcher({ run: async (xs) => xs, maxBatchSize: 2 });
    await Promise.all([mb.submit(1), mb.submit(2)]);
    await Promise.all([mb.submit(3), mb.submit(4)]);
    const s = mb.snapshot();
    assert.equal(s.totalFlushes, 2);
    assert.equal(s.totalItems, 4);
    assert.equal(s.avgBatchSize, 2);
  });
});

describe('createMicrobatcher — context propagation', () => {
  test('runner receives the per-item ctx array', async () => {
    let seenCtxs = null;
    const mb = createMicrobatcher({
      run: async (xs, ctxs) => { seenCtxs = ctxs; return xs; },
      maxBatchSize: 3, maxLatencyMs: 5,
    });
    await Promise.all([
      mb.submit('a', { tenant: 't1' }),
      mb.submit('b', { tenant: 't2' }),
      mb.submit('c', { tenant: 't1' }),
    ]);
    assert.deepEqual(seenCtxs.map((c) => c.tenant), ['t1', 't2', 't1']);
  });
});
