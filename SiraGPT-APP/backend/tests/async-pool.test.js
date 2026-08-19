'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { asyncPool, asyncMap, AsyncPoolAbortError } = require('../src/utils/async-pool');

function later(ms, value) {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

describe('asyncPool — basic', () => {
  test('returns results in input order', async () => {
    const r = await asyncPool({
      items: [1, 2, 3, 4, 5],
      worker: async (n) => later(Math.random() * 20, n * 10),
      concurrency: 2,
    });
    assert.deepEqual(r, [10, 20, 30, 40, 50]);
  });

  test('asyncMap is an alias', async () => {
    const r = await asyncMap([1, 2, 3], async (n) => n + 1, { concurrency: 2 });
    assert.deepEqual(r, [2, 3, 4]);
  });

  test('empty input returns []', async () => {
    const r = await asyncPool({ items: [], worker: async () => 1 });
    assert.deepEqual(r, []);
  });

  test('rejects bad inputs', async () => {
    await assert.rejects(asyncPool({ items: [1], worker: 'nope' }), TypeError);
    await assert.rejects(asyncPool({ items: 42, worker: async () => 1 }), TypeError);
  });
});

describe('asyncPool — concurrency cap', () => {
  test('never runs more than `concurrency` workers in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await asyncPool({
      items: Array.from({ length: 30 }, (_, i) => i),
      concurrency: 4,
      worker: async (n) => {
        inFlight += 1; if (inFlight > peak) peak = inFlight;
        await later(5);
        inFlight -= 1;
        return n;
      },
    });
    assert.equal(r.length, 30);
    assert.ok(peak <= 4, `peak=${peak} exceeded 4`);
  });
});

describe('asyncPool — error handling', () => {
  test('mode=all throws on first error', async () => {
    await assert.rejects(
      asyncPool({
        items: [1, 2, 3],
        worker: async (n) => { if (n === 2) throw new Error('boom'); return n; },
        concurrency: 2,
      }),
      /boom/,
    );
  });

  test('mode=settle returns per-item status', async () => {
    const r = await asyncPool({
      items: [1, 2, 3],
      mode: 'settle',
      worker: async (n) => { if (n === 2) throw new Error('boom'); return n; },
    });
    assert.equal(r[0].status, 'fulfilled');
    assert.equal(r[1].status, 'rejected');
    assert.equal(r[1].reason.message, 'boom');
    assert.equal(r[2].status, 'fulfilled');
  });
});

describe('asyncPool — abort', () => {
  test('pre-aborted signal throws AsyncPoolAbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort('test');
    await assert.rejects(
      asyncPool({ items: [1], worker: async () => 1, signal: ctrl.signal }),
      AsyncPoolAbortError,
    );
  });

  test('mid-run abort stops scheduling new work', async () => {
    const ctrl = new AbortController();
    let started = 0;
    const promise = asyncPool({
      items: Array.from({ length: 50 }, (_, i) => i),
      concurrency: 2,
      signal: ctrl.signal,
      worker: async () => { started += 1; await later(50); },
    });
    await later(20);
    ctrl.abort('cancel');
    await assert.rejects(promise, AsyncPoolAbortError);
    assert.ok(started < 50);
  });
});

describe('asyncPool — worker receives index + signal', () => {
  test('index matches input position', async () => {
    const seen = [];
    await asyncPool({
      items: ['a', 'b', 'c'],
      worker: async (item, i) => { seen.push([item, i]); return i; },
      concurrency: 1,
    });
    assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
  });

  test('signal is forwarded', async () => {
    const ctrl = new AbortController();
    let observed = null;
    const promise = asyncPool({
      items: [1],
      signal: ctrl.signal,
      worker: async (_n, _i, signal) => { observed = signal; await later(100); },
    });
    ctrl.abort();
    await assert.rejects(promise);
    assert.ok(observed);
    assert.equal(observed.aborted, true);
  });
});
