'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  createLeaseMutex,
  LeaseHeldError,
  LeaseInvalidError,
  DEFAULT_TTL_MS,
} = require('../src/services/concurrency/lease-mutex');

function mk(t0 = 0) {
  let t = t0;
  return {
    m: createLeaseMutex({ now: () => t }),
    advance: (ms) => { t += ms; },
    setT: (v) => { t = v; },
  };
}

describe('lease-mutex — acquire / release', () => {
  test('first acquire returns a token', async () => {
    const { m } = mk();
    const lock = await m.acquire('job:cleanup', { ttlMs: 1000, holderId: 'worker-1' });
    assert.ok(lock.token.length === 32);
    assert.equal(typeof lock.expiresAt, 'number');
  });

  test('second acquire while held throws LeaseHeldError', async () => {
    const { m } = mk();
    await m.acquire('k', { ttlMs: 1000 });
    await assert.rejects(m.acquire('k', { ttlMs: 1000 }), LeaseHeldError);
  });

  test('tryAcquire returns null when held instead of throwing', async () => {
    const { m } = mk();
    await m.acquire('k', { ttlMs: 1000 });
    assert.equal(m.tryAcquire('k', { ttlMs: 1000 }), null);
  });

  test('release with correct token frees the lease', async () => {
    const { m } = mk();
    const lock = await m.acquire('k', { ttlMs: 1000 });
    assert.equal(m.release('k', lock.token), true);
    assert.ok(m.tryAcquire('k', { ttlMs: 1000 })); // can acquire again
  });

  test('release with wrong token returns false', async () => {
    const { m } = mk();
    await m.acquire('k', { ttlMs: 1000 });
    assert.equal(m.release('k', 'fake-token'), false);
  });

  test('release on unknown key returns false', () => {
    const { m } = mk();
    assert.equal(m.release('never', 'tk'), false);
  });

  test('rejects empty key', async () => {
    const { m } = mk();
    await assert.rejects(m.acquire('', {}), TypeError);
  });
});

describe('lease-mutex — TTL expiry', () => {
  test('expired lease is treated as free on next acquire', async () => {
    const { m, advance } = mk();
    await m.acquire('k', { ttlMs: 100 });
    advance(200);
    const lock = await m.acquire('k', { ttlMs: 100 }); // peer takes over
    assert.ok(lock.token);
  });

  test('peek returns null after expiry', async () => {
    const { m, advance } = mk();
    await m.acquire('k', { ttlMs: 100 });
    assert.ok(m.peek('k'));
    advance(200);
    assert.equal(m.peek('k'), null);
  });
});

describe('lease-mutex — heartbeat', () => {
  test('heartbeat with correct token extends expiry', async () => {
    const { m, advance } = mk();
    const lock = await m.acquire('k', { ttlMs: 1000 });
    advance(800);
    const hb = m.heartbeat('k', lock.token);
    assert.ok(hb.expiresAt > lock.expiresAt);
  });

  test('heartbeat with wrong token throws LeaseInvalidError', async () => {
    const { m } = mk();
    await m.acquire('k', { ttlMs: 1000 });
    try { m.heartbeat('k', 'wrong'); assert.fail('should throw'); }
    catch (e) { assert.equal(e.reason, 'wrong_token'); }
  });

  test('heartbeat on no-lease throws LeaseInvalidError', () => {
    const { m } = mk();
    try { m.heartbeat('never', 'tk'); assert.fail('should throw'); }
    catch (e) { assert.equal(e.reason, 'no_lease'); }
  });

  test('heartbeat after TTL expired throws LeaseInvalidError(expired)', async () => {
    const { m, advance } = mk();
    const lock = await m.acquire('k', { ttlMs: 100 });
    advance(200);
    try { m.heartbeat('k', lock.token); assert.fail('should throw'); }
    catch (e) {
      assert.ok(e instanceof LeaseInvalidError);
      assert.equal(e.reason, 'expired');
    }
  });

  test('heartbeat with new ttlMs overrides default', async () => {
    const { m, advance } = mk();
    const lock = await m.acquire('k', { ttlMs: 100 });
    advance(50);
    const hb = m.heartbeat('k', lock.token, { ttlMs: 5000 });
    assert.equal(hb.expiresAt, 50 + 5000);
  });
});

describe('lease-mutex — peek + snapshot', () => {
  test('peek surfaces holder + remainingMs', async () => {
    const { m, advance } = mk();
    await m.acquire('k', { ttlMs: 1000, holderId: 'w1' });
    advance(300);
    const p = m.peek('k');
    assert.equal(p.holderId, 'w1');
    assert.equal(p.remainingMs, 700);
  });

  test('snapshot reports live + counters', async () => {
    const { m } = mk();
    await m.acquire('a', {});
    await m.acquire('b', {});
    m.tryAcquire('a', {}); // contention → reject
    const s = m.snapshot();
    assert.equal(s.live, 2);
    assert.equal(s.totalAcquires, 2);
    assert.equal(s.totalRejects, 1);
  });
});

describe('lease-mutex — defaults', () => {
  test('default ttl is 30s', async () => {
    const { m } = mk();
    const lock = await m.acquire('k', {});
    assert.equal(lock.expiresAt, 0 + DEFAULT_TTL_MS);
  });
});
