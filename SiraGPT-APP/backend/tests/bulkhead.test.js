/**
 * Tests for bulkhead.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  BulkheadPool, BulkheadFullError, BulkheadTimeoutError,
  BulkheadRejectedError, getBulkhead, allBulkheadStats, drainAll,
} = require('../src/services/agents/bulkhead');

describe('BulkheadPool', () => {
  it('acquire and release a slot', async () => {
    const pool = new BulkheadPool('test', { maxConcurrent: 5 });
    assert.strictEqual(pool.active, 0);
    const release = await pool.acquire();
    assert.strictEqual(pool.active, 1);
    release();
    assert.strictEqual(pool.active, 0);
  });

  it('execute runs function inside acquired slot', async () => {
    const pool = new BulkheadPool('test-exec');
    const result = await pool.execute(async () => 'hello bulkhead');
    assert.strictEqual(result, 'hello bulkhead');
    assert.strictEqual(pool.active, 0);
  });

  it('rejects when maxConcurrent exceeded (no queue)', async () => {
    const pool = new BulkheadPool('test-full', { maxConcurrent: 1, queueCapacity: 0 });
    const hold = pool.acquire();
    await assert.rejects(
      pool.execute(async () => 'should not run'),
      { name: 'BulkheadFullError', bulkheadName: 'test-full' }
    );
    const release = await hold;
    release();
  });

  it('queues waiters when maxConcurrent is reached', async () => {
    const pool = new BulkheadPool('test-queue', { maxConcurrent: 1, queueCapacity: 10 });
    const hold1 = await pool.acquire();
    const p2 = pool.acquire().then(r => { r(); return 'done'; });
    assert.strictEqual(pool.queued, 1);
    hold1();
    const result = await p2;
    assert.strictEqual(result, 'done');
  });

  it('priority queue: higher priority runs first', async () => {
    const pool = new BulkheadPool('test-priority', { maxConcurrent: 1, queueCapacity: 10 });
    const order = [];
    const hold = await pool.acquire();
    pool.acquire({ priority: -1 }).then(r => { order.push('low'); r(); });
    pool.acquire({ priority: 10 }).then(r => { order.push('high'); r(); });
    pool.acquire({ priority: 0 }).then(r => { order.push('normal'); r(); });
    assert.strictEqual(pool.queued, 3);
    hold();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(order[0], 'high', 'High priority should run first');
  });

  it('execute with per-op timeout', async () => {
    const pool = new BulkheadPool('test-timeout', { maxConcurrent: 1, timeoutMs: 50 });
    await assert.rejects(
      pool.execute(async () => { await new Promise(r => setTimeout(r, 500)); return 'slow'; }),
      { name: 'BulkheadTimeoutError', bulkheadName: 'test-timeout' }
    );
  });

  it('rejects new acquisitions after drain()', async () => {
    const pool = new BulkheadPool('test-drain', { maxConcurrent: 2 });
    setImmediate(() => pool.drain(1000));
    await new Promise(r => setTimeout(r, 10));
    await assert.rejects(pool.acquire(), { name: 'BulkheadRejectedError' });
  });

  it('emits drain_timeout (and resolves, not hangs) when active ops do not finish in time', async () => {
    const pool = new BulkheadPool('test-drain-timeout', { maxConcurrent: 2 });
    const release = await pool.acquire(); // 1 active, deliberately never released
    let event = null;
    pool.once('drain_timeout', (e) => { event = e; });
    await pool.drain(25); // active op never completes → timeout branch (must resolve)
    assert.ok(event, 'drain_timeout event fired');
    assert.strictEqual(event.name, 'test-drain-timeout');
    assert.ok(event.remainingActive >= 1, 'reports the still-active operation count');
    // Drain still flipped _draining, so new acquisitions are rejected.
    await assert.rejects(pool.acquire(), { name: 'BulkheadRejectedError' });
    release(); // cleanup
  });

  it('stats() returns meaningful data', async () => {
    const pool = new BulkheadPool('test-stats', { maxConcurrent: 3, queueCapacity: 10 });
    const hold = await pool.acquire();
    const stats = pool.stats();
    assert.strictEqual(stats.name, 'test-stats');
    assert.strictEqual(stats.active, 1);
    assert.strictEqual(stats.draining, false);
    hold();
  });

  it('constructor validates name', () => {
    assert.throws(() => new BulkheadPool(''), /name is required/);
    assert.throws(() => new BulkheadPool(null), /name is required/);
  });

  it('constructor validates maxConcurrent', () => {
    assert.throws(() => new BulkheadPool('test', { maxConcurrent: 0 }), /maxConcurrent must be >= 1/);
  });
});

describe('getBulkhead (singleton registry)', () => {
  it('returns same instance for same name', () => {
    const a = getBulkhead('shared-pool', { maxConcurrent: 5 });
    const b = getBulkhead('shared-pool');
    assert.strictEqual(a, b);
  });

  it('allBulkheadStats returns array', () => {
    getBulkhead('stats-test-a');
    getBulkhead('stats-test-b');
    const stats = allBulkheadStats();
    const names = stats.map(s => s.name);
    assert.ok(names.includes('stats-test-a'));
    assert.ok(names.includes('stats-test-b'));
  });

  it('drainAll drains and clears all pools', async () => {
    getBulkhead('drain-test');
    getBulkhead('drain-test-2');
    assert.ok(allBulkheadStats().length > 0);
    await drainAll(1000);
    assert.strictEqual(allBulkheadStats().length, 0);
  });
});

describe('BulkheadPool — queued abort listener cleanup', () => {
  const { getEventListeners } = require('node:events');

  it('detaches the abort listener when a queued acquire is granted', async () => {
    const pool = new BulkheadPool('leak-grant', { maxConcurrent: 1, queueCapacity: 10 });
    const rel1 = await pool.acquire();
    const ac = new AbortController();
    const p2 = pool.acquire({ signal: ac.signal }); // queues behind rel1
    rel1(); // release → _processQueue resolves p2 and must detach the listener
    const rel2 = await p2;
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
    rel2();
  });

  it('detaches abort listeners for queued waiters rejected by drain()', async () => {
    const pool = new BulkheadPool('leak-drain', { maxConcurrent: 1, queueCapacity: 10 });
    const rel1 = await pool.acquire();
    const ac = new AbortController();
    const p2 = pool.acquire({ signal: ac.signal }); // queues behind rel1
    const draining = pool.drain(1000);              // rejects queued p2 immediately
    await assert.rejects(p2);                        // queued waiter rejected by drain
    rel1();                                          // let the active op finish
    await draining;
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });
});
