'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createTokenBulkhead,
  BulkheadAcquireError,
} = require('../src/services/ai-product-os/token-bulkhead');

describe('createTokenBulkhead — happy path', () => {
  test('first acquire below limits returns a release fn', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 2, maxTokensInFlight: 1000 });
    const release = await bh.acquire({ tokens: 100 });
    const s = bh.snapshot();
    assert.equal(s.inFlight, 1);
    assert.equal(s.tokensInFlight, 100);
    release();
    const s2 = bh.snapshot();
    assert.equal(s2.inFlight, 0);
    assert.equal(s2.tokensInFlight, 0);
  });

  test('release is idempotent (double-release is a no-op)', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 2, maxTokensInFlight: 1000 });
    const r = await bh.acquire({ tokens: 100 });
    r(); r();
    assert.equal(bh.snapshot().inFlight, 0);
  });
});

describe('createTokenBulkhead — concurrency cap', () => {
  test('queues when maxConcurrent reached', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 1, maxTokensInFlight: 100_000 });
    const r1 = await bh.acquire({ tokens: 10 });
    let r2Resolved = false;
    const p2 = bh.acquire({ tokens: 10 }).then((r) => { r2Resolved = true; return r; });
    await Promise.resolve();
    assert.equal(r2Resolved, false);
    assert.equal(bh.snapshot().queued, 1);
    r1();
    const r2 = await p2;
    assert.equal(r2Resolved, true);
    r2();
  });
});

describe('createTokenBulkhead — token cap', () => {
  test('queues when next acquire would exceed token cap', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 10, maxTokensInFlight: 100 });
    const r1 = await bh.acquire({ tokens: 70 });
    let resolved = false;
    const p2 = bh.acquire({ tokens: 50 }).then((r) => { resolved = true; return r; });
    await Promise.resolve();
    assert.equal(resolved, false);
    r1();
    const r2 = await p2;
    assert.ok(resolved);
    r2();
  });

  test('rejects acquires that exceed total bulkhead capacity', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 10, maxTokensInFlight: 100 });
    await assert.rejects(bh.acquire({ tokens: 200 }), BulkheadAcquireError);
  });
});

describe('createTokenBulkhead — priority', () => {
  test('higher priority cuts the line', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 1, maxTokensInFlight: 1000 });
    const order = [];
    const r1 = await bh.acquire({ tokens: 10 }); // holding the slot
    const pLow = bh.acquire({ tokens: 10, priority: 0 }).then((r) => { order.push('low'); return r; });
    const pHi  = bh.acquire({ tokens: 10, priority: 5 }).then((r) => { order.push('hi'); return r; });
    r1();
    const rHi = await pHi;
    rHi();
    const rLow = await pLow;
    rLow();
    assert.deepEqual(order, ['hi', 'low']);
  });
});

describe('createTokenBulkhead — abort', () => {
  test('abort before acquire rejects', async () => {
    const bh = createTokenBulkhead({});
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(bh.acquire({ tokens: 10, signal: ctrl.signal }), /aborted/);
  });

  test('abort while queued drops out cleanly', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 1 });
    const r1 = await bh.acquire({ tokens: 10 });
    const ctrl = new AbortController();
    const p = bh.acquire({ tokens: 10, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(p, /aborted/);
    r1();
    assert.equal(bh.snapshot().queued, 0);
  });
});

describe('createTokenBulkhead — drain', () => {
  test('drain resolves when in-flight + queue empty', async () => {
    const bh = createTokenBulkhead({ maxConcurrent: 1 });
    const r1 = await bh.acquire({ tokens: 10 });
    let drained = false;
    const dp = bh.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    r1();
    await dp;
    assert.equal(drained, true);
  });

  test('drain on empty bulkhead resolves immediately', async () => {
    const bh = createTokenBulkhead({});
    await bh.drain(); // must not hang
  });
});

describe('createTokenBulkhead — snapshot', () => {
  test('exposes counters and config', async () => {
    const bh = createTokenBulkhead({ model: 'gpt-5', maxConcurrent: 2, maxTokensInFlight: 500 });
    const r = await bh.acquire({ tokens: 100 });
    const s = bh.snapshot();
    assert.equal(s.model, 'gpt-5');
    assert.equal(s.maxConcurrent, 2);
    assert.equal(s.maxTokensInFlight, 500);
    assert.equal(s.inFlight, 1);
    assert.equal(s.tokensInFlight, 100);
    assert.equal(s.totalAcquires, 1);
    r();
  });
});
