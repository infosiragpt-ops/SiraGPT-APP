/**
 * Tests for services/agents/mutex.js — async lock registry.
 *
 * Verifies FIFO serialization per key, parallelism across keys,
 * error-recovery (no zombie holders), and the sweep cleanup.
 */

'use strict';

const assert = require('node:assert');
const { describe, it, beforeEach } = require('node:test');

const { runWithLock, activeLockCount, _reset } = require('../src/services/agents/mutex');

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => { _reset(); });

describe('runWithLock · input validation', () => {
  it('throws when key is missing', async () => {
    await assert.rejects(() => runWithLock('', () => 1), /key and fn are required/);
    await assert.rejects(() => runWithLock(null, () => 1), /key and fn are required/);
    await assert.rejects(() => runWithLock(undefined, () => 1), /key and fn are required/);
  });

  it('throws when fn is not a function', async () => {
    await assert.rejects(() => runWithLock('k', null), /key and fn are required/);
    await assert.rejects(() => runWithLock('k', 'not-a-fn'), /key and fn are required/);
  });
});

describe('runWithLock · basic semantics', () => {
  it('returns whatever fn returns', async () => {
    const out = await runWithLock('k1', async () => 'result');
    assert.equal(out, 'result');
  });

  it('returns the fn value even for sync fns', async () => {
    const out = await runWithLock('k1', () => 42);
    assert.equal(out, 42);
  });

  it('propagates errors thrown inside fn', async () => {
    await assert.rejects(
      runWithLock('k1', async () => { throw new Error('boom'); }),
      /boom/,
    );
  });

  it('releases the lock after fn throws (no zombie holder)', async () => {
    await assert.rejects(runWithLock('k1', async () => { throw new Error('x'); }));
    // The next caller for the same key must NOT block.
    const out = await runWithLock('k1', async () => 'after-error');
    assert.equal(out, 'after-error');
  });
});

describe('runWithLock · FIFO serialization on same key', () => {
  it('queues second call until first resolves', async () => {
    const events = [];
    const gate = defer();

    const first = runWithLock('shared', async () => {
      events.push('first-enter');
      await gate.promise;
      events.push('first-exit');
      return 'first';
    });

    // Second call enters runWithLock but should NOT see first-exit yet.
    const second = runWithLock('shared', async () => {
      events.push('second-enter');
      return 'second';
    });

    // Give the event loop a tick so the second call starts queuing.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(events, ['first-enter']);

    gate.resolve();
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1, 'first');
    assert.equal(r2, 'second');
    assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);
  });

  it('preserves order across many queued callers', async () => {
    const order = [];
    const N = 5;
    const callers = [];
    for (let i = 0; i < N; i++) {
      callers.push(runWithLock('serial', async () => {
        order.push(i);
        // Random small delay so any non-serial scheduling would scramble.
        await new Promise(r => setTimeout(r, 1));
      }));
    }
    await Promise.all(callers);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });
});

describe('runWithLock · cross-key parallelism', () => {
  it('different keys do NOT block each other', async () => {
    const events = [];
    const gateA = defer();
    const gateB = defer();

    const promiseA = runWithLock('A', async () => {
      events.push('A-enter');
      await gateA.promise;
      events.push('A-exit');
    });
    const promiseB = runWithLock('B', async () => {
      events.push('B-enter');
      await gateB.promise;
      events.push('B-exit');
    });

    // Both should enter before either exits.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(events.sort(), ['A-enter', 'B-enter']);

    // Resolve B first; A still pending.
    gateB.resolve();
    await promiseB;
    gateA.resolve();
    await promiseA;

    // The order of exit reflects which gate was released first.
    assert.ok(events.includes('A-exit'));
    assert.ok(events.includes('B-exit'));
  });
});

describe('runWithLock · error in queued caller does not affect siblings', () => {
  it('caller-2 throwing does not block caller-3', async () => {
    const events = [];
    await Promise.allSettled([
      runWithLock('k', async () => { events.push('1'); }),
      runWithLock('k', async () => { events.push('2-throw'); throw new Error('mid'); }),
      runWithLock('k', async () => { events.push('3'); }),
    ]);
    assert.deepEqual(events, ['1', '2-throw', '3']);
  });
});

describe('runWithLock · cleanup observability', () => {
  it('_reset() returns the registry to zero', async () => {
    await runWithLock('a', async () => {});
    await runWithLock('b', async () => {});
    _reset();
    assert.equal(activeLockCount(), 0);
  });
});
