'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BulkheadPool } = require('../src/services/agents/bulkhead');

/**
 * drain() used to register a `released` listener that was never removed on
 * either settle path. Since pools are cached in a module-level registry and
 * reused, the stale listener kept firing on every subsequent release and a
 * fresh closure leaked per drain — MaxListenersExceededWarning after 10.
 */

test('drain() removes its released listener once active ops finish', async () => {
  const pool = new BulkheadPool('drain-leak-test', { maxConcurrent: 1 });
  const release = await pool.acquire();
  assert.equal(pool.active, 1);

  const drained = pool.drain(5000);   // active > 0 → installs the listener
  release();                           // → emits 'released', active drops to 0
  await drained;

  assert.equal(pool.listenerCount('released'), 0, 'released listener must be detached after drain settles');
});

test('concurrent drains do not accumulate released listeners', async () => {
  const pool = new BulkheadPool('drain-leak-test-multi', { maxConcurrent: 1 });
  const release = await pool.acquire();

  const drains = [pool.drain(5000), pool.drain(5000), pool.drain(5000)];
  assert.ok(pool.listenerCount('released') <= 3, 'one listener per in-flight drain at most');

  release();
  await Promise.all(drains);

  assert.equal(pool.listenerCount('released'), 0, 'all drain listeners detached after settle');
});

test('drain() on an idle pool resolves without leaving a listener', async () => {
  const pool = new BulkheadPool('drain-idle-test', { maxConcurrent: 2 });
  await pool.drain(5000); // active === 0 → early return, never installs a listener
  assert.equal(pool.listenerCount('released'), 0);
});
