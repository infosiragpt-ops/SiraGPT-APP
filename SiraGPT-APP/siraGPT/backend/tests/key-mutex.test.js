'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createKeyMutex } = require('../src/utils/key-mutex');

function later(ms, value) {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

describe('createKeyMutex — acquire/release', () => {
  test('first acquire is immediate; release frees the slot', async () => {
    const mu = createKeyMutex({});
    const r = await mu.acquire('k');
    assert.equal(mu.isLocked('k'), true);
    r();
    assert.equal(mu.isLocked('k'), false);
  });

  test('second acquire on same key waits for first to release', async () => {
    const mu = createKeyMutex({});
    const order = [];
    const r1 = await mu.acquire('k');
    const p2 = mu.acquire('k').then((rel) => { order.push('second'); rel(); });
    await later(10);
    order.push('first-still-holding');
    r1();
    await p2;
    assert.deepEqual(order, ['first-still-holding', 'second']);
  });

  test('different keys do not block each other', async () => {
    const mu = createKeyMutex({});
    const r1 = await mu.acquire('a');
    const r2 = await mu.acquire('b'); // must not block on 'a'
    r1(); r2();
  });

  test('release is idempotent', async () => {
    const mu = createKeyMutex({});
    const r = await mu.acquire('k');
    r(); r(); r();
    assert.equal(mu.isLocked('k'), false);
  });

  test('rejects empty key', async () => {
    const mu = createKeyMutex({});
    await assert.rejects(mu.acquire(''), TypeError);
  });
});

describe('createKeyMutex — withLock', () => {
  test('serializes concurrent calls on the same key', async () => {
    const mu = createKeyMutex({});
    const calls = [];
    const work = async (label) => {
      calls.push(`${label}:start`);
      await later(20);
      calls.push(`${label}:end`);
      return label;
    };
    const [a, b, c] = await Promise.all([
      mu.withLock('k', () => work('A')),
      mu.withLock('k', () => work('B')),
      mu.withLock('k', () => work('C')),
    ]);
    // A must complete before B starts, B before C starts.
    const aEnd = calls.indexOf('A:end');
    const bStart = calls.indexOf('B:start');
    const bEnd = calls.indexOf('B:end');
    const cStart = calls.indexOf('C:start');
    assert.ok(aEnd < bStart);
    assert.ok(bEnd < cStart);
    assert.deepEqual([a, b, c], ['A', 'B', 'C']);
  });

  test('throwing fn releases the lock', async () => {
    const mu = createKeyMutex({});
    await assert.rejects(mu.withLock('k', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(mu.isLocked('k'), false);
    // Should immediately be acquirable again.
    const r = await mu.acquire('k');
    r();
  });

  test('rejects non-function fn', async () => {
    const mu = createKeyMutex({});
    await assert.rejects(mu.withLock('k', 'not-a-fn'), TypeError);
  });
});

describe('createKeyMutex — snapshot', () => {
  test('exposes activeKeys + counters', async () => {
    const mu = createKeyMutex({});
    const r = await mu.acquire('k');
    const s = mu.snapshot();
    assert.equal(s.activeKeys, 1);
    assert.ok(s.totalAcquires >= 1);
    r();
  });

  test('totalQueued increments only on contended acquires', async () => {
    const mu = createKeyMutex({});
    const r = await mu.acquire('k');
    const p = mu.acquire('k'); // queued
    r();
    (await p)();
    assert.equal(mu.snapshot().totalQueued, 1);
  });
});
