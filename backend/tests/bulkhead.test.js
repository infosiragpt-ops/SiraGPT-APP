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
