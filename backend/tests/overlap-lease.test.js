'use strict';

/**
 * overlap-lease — Redis SET NX overlap guard + local fallback.
 * Injectable fake Redis and a manual clock (no wall-clock sleeps).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  createOverlapLease,
  leaseKey,
  clampTtl,
  parseSetFlags,
  heldResult,
  setDefaultOverlapLease,
  getDefaultOverlapLease,
  ensureDefaultRedisClient,
  acquireJobOverlap,
  releaseJobOverlap,
  OVERLAP_HELD_REASON_ES,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
  KEY_PREFIX,
  RENEW_SCRIPT,
  RELEASE_SCRIPT,
} = require('../src/services/scheduler/overlap-lease');

function createClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (value) => { t = value; },
  };
}

function createFakeRedis({ now, failOn } = {}) {
  const kv = new Map();
  const calls = [];
  const state = { failOn: failOn || null };

  function expireRow(key) {
    const row = kv.get(key);
    if (!row) return null;
    if (row.expiresAt <= now()) {
      kv.delete(key);
      return null;
    }
    return row;
  }

  function fail(op) {
    if (state.failOn === op || state.failOn === 'all') {
      const err = new Error('redis_down');
      err.code = 'ECONNREFUSED';
      throw err;
    }
  }

  return {
    calls,
    kv,
    get failOn() { return state.failOn; },
    set failOn(value) { state.failOn = value; },
    async set(key, value, ...args) {
      calls.push(['set', key]);
      fail('set');
      const flags = parseSetFlags(args);
      const ttl = Number.isFinite(flags.px) && flags.px > 0 ? flags.px : 1;
      const live = expireRow(key);
      if (flags.nx && live) return null;
      kv.set(key, { value: String(value), expiresAt: now() + ttl });
      return 'OK';
    },
    async get(key) {
      calls.push(['get', key]);
      fail('get');
      const row = expireRow(key);
      return row ? row.value : null;
    },
    async eval(script, _nKeys, key, token, ttl) {
      calls.push(['eval', key]);
      fail('eval');
      const row = expireRow(key);
      if (!row || row.value !== String(token)) return 0;
      if (String(script).includes('DEL')) {
        kv.delete(key);
        return 1;
      }
      if (String(script).includes('PEXPIRE')) {
        row.expiresAt = now() + Number(ttl);
        return 1;
      }
      return 0;
    },
    async pttl(key) {
      const row = expireRow(key);
      return row ? Math.max(0, row.expiresAt - now()) : -2;
    },
  };
}

describe('overlap-lease helpers', () => {
  test('builds a scoped Redis key without raw punctuation', () => {
    const key = leaseKey({ jobId: 'job/one', ownerId: 'user:42' });
    assert.equal(key, `${KEY_PREFIX}user_42:job_one`);
  });

  test('rejects an empty jobId', () => {
    assert.throws(() => leaseKey({ jobId: '  ' }), /jobId required/);
  });

  test('clamps TTL to the documented bounds', () => {
    assert.equal(clampTtl(undefined), DEFAULT_TTL_MS);
    assert.equal(clampTtl(1), MIN_TTL_MS);
    assert.equal(clampTtl(999_999), MAX_TTL_MS);
  });

  test('parseSetFlags accepts both PX/NX argument orders and object form', () => {
    assert.deepEqual(parseSetFlags(['PX', 80, 'NX']), { nx: true, px: 80 });
    assert.deepEqual(parseSetFlags(['NX', 'PX', 40]), { nx: true, px: 40 });
    assert.deepEqual(parseSetFlags([{ NX: true, PX: 12 }]), { nx: true, px: 12 });
  });

  test('heldResult is fail-closed Spanish copy with a stable code', () => {
    const skip = heldResult({ jobId: 'j1', distributed: true });
    assert.equal(skip.ok, false);
    assert.equal(skip.code, 'overlap_skipped');
    assert.equal(skip.reason, OVERLAP_HELD_REASON_ES);
    assert.match(skip.reason, /solapamiento/);
    assert.equal(skip.reason.includes('OpenClaw'), false);
    assert.equal(skip.reason.includes('Redis'), false);
  });
});

describe('Redis acquire / renew / release', () => {
  test('first acquire wins and stores the token', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'a', ownerId: 'u1' });
    assert.equal(first.ok, true);
    assert.equal(first.mode, 'redis');
    assert.equal(first.distributed, true);
    assert.equal(first.token.length, 32);
    assert.equal(await redis.get(first.key), first.token);
  });

  test('second acquire fail-closes with the Spanish overlap reason', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const workerA = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const workerB = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await workerA.acquire({ jobId: 'shared', ownerId: 'u1' });
    const second = await workerB.acquire({ jobId: 'shared', ownerId: 'u1' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'overlap_skipped');
    assert.equal(second.reason, OVERLAP_HELD_REASON_ES);
    assert.equal(second.distributed, true);
    assert.equal(JSON.stringify(second).includes(first.token), false);
  });

  test('different job ids do not collide', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const a = await lease.acquire({ jobId: 'one', ownerId: 'u1' });
    const b = await lease.acquire({ jobId: 'two', ownerId: 'u1' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  test('different owners do not collide on the same job id', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const a = await lease.acquire({ jobId: 'same', ownerId: 'owner-A' });
    const b = await lease.acquire({ jobId: 'same', ownerId: 'owner-B' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  test('release with the holder token allows a later acquire', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'rel', ownerId: 'u1' });
    assert.equal(await lease.release(first), true);
    const again = await lease.acquire({ jobId: 'rel', ownerId: 'u1' });
    assert.equal(again.ok, true);
    assert.notEqual(again.token, first.token);
  });

  test('release with the wrong token leaves the lease held', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'wrong', ownerId: 'u1' });
    assert.equal(await lease.release({ ...first, token: '0'.repeat(32) }), false);
    const second = await lease.acquire({ jobId: 'wrong', ownerId: 'u1' });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'overlap_skipped');
  });

  test('release of an unknown claim is false', async () => {
    const lease = createOverlapLease({ now: () => 1 });
    assert.equal(await lease.release({ key: 'sira:job-overlap:_:ghost', token: 'abc' }), false);
  });

  test('renew extends TTL; fake clock expiry then allows steal', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'ttl', ownerId: 'u1', ttlMs: 90 });
    clock.advance(80);
    const renewed = await lease.renew(first, { ttlMs: 90 });
    assert.equal(renewed.ok, true);
    clock.advance(80);
    const stillHeld = await lease.acquire({ jobId: 'ttl', ownerId: 'u1' });
    assert.equal(stillHeld.ok, false);
    clock.advance(20);
    const stolen = await lease.acquire({ jobId: 'ttl', ownerId: 'u1' });
    assert.equal(stolen.ok, true);
  });

  test('renew with the wrong token fails closed', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'rnw', ownerId: 'u1' });
    const bad = await lease.renew({ ...first, token: 'nope' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'LEASE_INVALID');
    assert.equal((await lease.acquire({ jobId: 'rnw', ownerId: 'u1' })).ok, false);
  });

  test('renew of an expired lease fails and does not recreate it', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 50 });
    const first = await lease.acquire({ jobId: 'exp', ownerId: 'u1', ttlMs: 50 });
    clock.advance(60);
    const late = await lease.renew(first);
    assert.equal(late.ok, false);
    const next = await lease.acquire({ jobId: 'exp', ownerId: 'u1' });
    assert.equal(next.ok, true);
  });
});

describe('Redis down fallback (documented honesty)', () => {
  test('acquire falls back to the local map and flags redis_unavailable', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'fb', ownerId: 'u1' });
    assert.equal(first.ok, true);
    assert.equal(first.mode, 'local');
    assert.equal(first.distributed, false);
    assert.equal(first.fallback, 'redis_unavailable');
    assert.equal(lease.snapshot().redisDisabled, true);
    assert.equal(lease.snapshot().distributed, false);
  });

  test('same worker still skips overlap after Redis falls back', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    assert.equal((await lease.acquire({ jobId: 'fb2', ownerId: 'u1' })).ok, true);
    const second = await lease.acquire({ jobId: 'fb2', ownerId: 'u1' });
    assert.equal(second.ok, false);
    assert.equal(second.reason, OVERLAP_HELD_REASON_ES);
    assert.equal(second.distributed, false);
    assert.equal(second.fallback, 'redis_unavailable');
  });

  test('two workers with Redis down each acquire locally (honesty)', async () => {
    const clock = createClock();
    const down = { set: async () => { throw Object.assign(new Error('redis_down'), { code: 'ECONNREFUSED' }); } };
    const workerA = createOverlapLease({ redis: down, now: clock.now, ttlMs: 90 });
    const workerB = createOverlapLease({ redis: down, now: clock.now, ttlMs: 90 });
    const a = await workerA.acquire({ jobId: 'split', ownerId: 'u1' });
    const b = await workerB.acquire({ jobId: 'split', ownerId: 'u1' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.distributed, false);
    assert.equal(b.distributed, false);
    assert.equal(a.fallback, 'redis_unavailable');
  });

  test('held Redis NX is not treated as Redis-down fallback', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    await lease.acquire({ jobId: 'nx', ownerId: 'u1' });
    const skip = await lease.acquire({ jobId: 'nx', ownerId: 'u1' });
    assert.equal(skip.fallback, null);
    assert.equal(skip.distributed, true);
    assert.equal(lease.snapshot().fallbackCount, 0);
  });

  test('local-only mode (no Redis) is honest about not being distributed', async () => {
    const clock = createClock();
    const lease = createOverlapLease({ now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'solo', ownerId: 'u1' });
    assert.equal(first.mode, 'local');
    assert.equal(first.fallback, 'local_only');
    assert.equal(first.distributed, false);
  });

  test('renew after Redis dies reports redis_unavailable and does not steal', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const first = await lease.acquire({ jobId: 'die', ownerId: 'u1' });
    redis.failOn = 'eval';
    const renewed = await lease.renew(first);
    assert.equal(renewed.ok, false);
    assert.equal(renewed.fallback, 'redis_unavailable');
    redis.failOn = null;
    const still = await lease.acquire({ jobId: 'die', ownerId: 'u1' });
    assert.equal(still.ok, false);
  });
});

describe('recovery after transient Redis failures', () => {
  test('a later acquisition returns to Redis after the local holder releases', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const localClaim = await lease.acquire({ jobId: 'recover', ownerId: 'u1' });
    assert.equal(localClaim.distributed, false);
    await lease.release(localClaim);
    redis.failOn = null;
    const recovered = await lease.acquire({ jobId: 'recover', ownerId: 'u1' });
    assert.equal(recovered.mode, 'redis');
    assert.equal(recovered.distributed, true);
    assert.equal(lease.snapshot().redisDisabled, false);
    assert.equal((await createOverlapLease({ redis, now: clock.now }).acquire({ jobId: 'recover', ownerId: 'u1' })).ok, false);
  });

  test('reattaching Redis cannot replace an active local-only holder', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const localClaim = await lease.acquire({ jobId: 'local-running', ownerId: 'u1' });
    redis.failOn = null;
    lease.attachRedis(redis);
    const skip = await lease.acquire({ jobId: 'local-running', ownerId: 'u1' });
    assert.equal(skip.ok, false);
    assert.equal(skip.distributed, false);
    assert.equal(redis.kv.size, 0, 'do not create a second claim in Redis');
    clock.advance(80);
    assert.equal((await lease.renew(localClaim)).mode, 'local');
    clock.advance(80);
    assert.equal((await lease.acquire({ jobId: 'local-running', ownerId: 'u1' })).ok, false);
    await lease.release(localClaim);
    assert.equal((await lease.acquire({ jobId: 'local-running', ownerId: 'u1' })).mode, 'redis');
  });

  test('an expired local-only holder does not block recovery forever', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const old = await lease.acquire({ jobId: 'local-expired', ownerId: 'u1' });
    redis.failOn = null;
    clock.advance(91);
    const current = await lease.acquire({ jobId: 'local-expired', ownerId: 'u1' });
    assert.equal(current.mode, 'redis');
    assert.equal(await lease.release(old), false);
    assert.equal(await redis.get(current.key), current.token);
  });

  test('a second failed Redis renewal never reports local renewal success', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const claim = await lease.acquire({ jobId: 'renew-down', ownerId: 'u1' });
    redis.failOn = 'eval';
    assert.equal((await lease.renew(claim)).ok, false);
    const again = await lease.renew(claim);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'redis_unavailable');
  });

  test('renewal recovers against the real token, never only its local shadow', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const claim = await lease.acquire({ jobId: 'renew-recovered', ownerId: 'u1' });
    redis.failOn = 'eval';
    assert.equal((await lease.renew(claim)).ok, false);
    redis.failOn = null;
    clock.advance(20);
    const renewed = await lease.renew(claim);
    assert.equal(renewed.ok, true);
    assert.equal(renewed.mode, 'redis');
    assert.equal(await redis.pttl(claim.key), 90);
    assert.equal(lease.snapshot().redisDisabled, false);
  });

  test('recovery cannot renew or release a replacement owner token', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const old = await lease.acquire({ jobId: 'replacement', ownerId: 'u1' });
    redis.failOn = 'eval';
    await lease.renew(old);
    redis.failOn = null;
    redis.kv.set(old.key, { value: 'replacement-owner-fixture', expiresAt: clock.now() + 90 });
    const renewed = await lease.renew(old);
    assert.equal(renewed.ok, false);
    assert.equal(renewed.reason, 'wrong_token');
    await lease.release(old);
    assert.equal(await redis.get(old.key), 'replacement-owner-fixture');
  });

  test('only one same-worker acquisition is in flight per key, even across a failure', async () => {
    const clock = createClock();
    let failFirst;
    let calls = 0;
    const redis = { set: () => {
      calls++;
      return new Promise((_resolve, reject) => { failFirst = reject; });
    } };
    const lease = createOverlapLease({ redis, now: clock.now });
    const first = lease.acquire({ jobId: 'pending', ownerId: 'u1' });
    const second = lease.acquire({ jobId: 'pending', ownerId: 'u1' });
    // Inspect before awaiting: the regression must not leave the fixture hanging.
    assert.equal(calls, 1);
    assert.equal((await second).ok, false);
    failFirst(Object.assign(new Error('redis_down'), { code: 'ECONNREFUSED' }));
    const localClaim = await first;
    assert.equal(localClaim.mode, 'local');
    assert.equal(lease.snapshot().pendingAcquires, 0);
    await lease.release(localClaim);
  });

  test('default helpers reuse their configured client through fallback and recovery', async () => {
    const previous = getDefaultOverlapLease();
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now, failOn: 'set' });
    setDefaultOverlapLease(createOverlapLease({ now: clock.now }));
    let created = 0;
    const options = { env: { NODE_ENV: 'production', REDIS_URL: 'redis://fixture' }, createClient: () => { created++; return redis; } };
    try {
      ensureDefaultRedisClient(options);
      const first = await acquireJobOverlap({ jobId: 'singleton', ownerId: 'u1' });
      await releaseJobOverlap(first);
      ensureDefaultRedisClient(options);
      assert.equal(created, 1, 'do not leak a second client after fallback');
      redis.failOn = null;
      assert.equal((await acquireJobOverlap({ jobId: 'singleton', ownerId: 'u1' })).mode, 'redis');
    } finally { setDefaultOverlapLease(previous); }
  });

  test('detaching Redis cannot turn distributed renewal into local success', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const claim = await lease.acquire({ jobId: 'detached', ownerId: 'u1' });
    lease.attachRedis(null);
    const renewed = await lease.renew(claim);
    assert.equal(renewed.ok, false);
    assert.equal(renewed.reason, 'redis_unavailable');
  });

  test('a denied command clears the acquisition reservation and never falls back locally', async () => {
    const clock = createClock();
    const redis = { set: async () => { throw new Error('NOPERM fixture command denied'); } };
    const lease = createOverlapLease({ redis, now: clock.now });
    const denied = await lease.acquire({ jobId: 'denied', ownerId: 'u1' });
    assert.equal(denied.ok, false);
    assert.equal(lease.snapshot().pendingAcquires, 0);
    assert.equal(lease.snapshot().fallbackCount, 0);
    assert.equal(lease.snapshot().liveLocal, 0);
    assert.equal(JSON.stringify(denied).includes('NOPERM'), false);
    lease.attachRedis(createFakeRedis({ now: clock.now }));
    assert.equal((await lease.acquire({ jobId: 'denied', ownerId: 'u1' })).ok, true);
  });
});

describe('withLease and renew timers', () => {
  test('withLease runs the function and releases afterwards', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const seen = await lease.withLease({ jobId: 'wl', ownerId: 'u1' }, async (claim) => {
      assert.equal(claim.ok, true);
      return 'did-work';
    });
    assert.equal(seen, 'did-work');
    assert.equal((await lease.acquire({ jobId: 'wl', ownerId: 'u1' })).ok, true);
  });

  test('withLease does not run the function when the lease is held', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    await lease.acquire({ jobId: 'held', ownerId: 'u1' });
    let ran = false;
    const skip = await lease.withLease({ jobId: 'held', ownerId: 'u1' }, async () => {
      ran = true;
      return 'nope';
    });
    assert.equal(ran, false);
    assert.equal(skip.code, 'overlap_skipped');
    assert.equal(skip.reason, OVERLAP_HELD_REASON_ES);
  });

  test('withLease releases after the function throws', async () => {
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    await assert.rejects(
      lease.withLease({ jobId: 'boom', ownerId: 'u1' }, async () => {
        throw new Error('synthetic');
      }),
      /synthetic/,
    );
    assert.equal((await lease.acquire({ jobId: 'boom', ownerId: 'u1' })).ok, true);
  });

  test('startRenew uses fake timers to extend the lease', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    const lease = createOverlapLease({ redis, now: clock.now, ttlMs: 90 });
    const claim = await lease.acquire({ jobId: 'tick', ownerId: 'u1', ttlMs: 90 });
    const renews = [];
    const stop = lease.startRenew(claim, {
      intervalMs: 30,
      onRenew: (result) => renews.push(result),
    });
    clock.advance(30);
    t.mock.timers.tick(30);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renews.length >= 1, true);
    assert.equal(renews[0].ok, true);
    stop();
    t.mock.timers.tick(30);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renews.length, 1);
    await lease.release(claim);
  });
});

describe('default singleton and production attach', () => {
  test('acquireJobOverlap uses the default lease', async () => {
    const previous = getDefaultOverlapLease();
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    setDefaultOverlapLease(createOverlapLease({ redis, now: clock.now, ttlMs: 90 }));
    try {
      const first = await acquireJobOverlap({ jobId: 'def', ownerId: 'u1' });
      const second = await acquireJobOverlap({ jobId: 'def', ownerId: 'u1' });
      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      await releaseJobOverlap(first);
    } finally {
      setDefaultOverlapLease(previous);
    }
  });

  test('ensureDefaultRedisClient is a no-op in NODE_ENV=test', () => {
    const before = getDefaultOverlapLease();
    const after = ensureDefaultRedisClient({
      env: { NODE_ENV: 'test', REDIS_URL: 'redis://should-not-connect' },
      createClient: () => { throw new Error('must not connect'); },
    });
    assert.equal(after, before);
    assert.equal(after.snapshot().redisAttached, false);
  });

  test('ensureDefaultRedisClient attaches an injected client outside tests', () => {
    const previous = getDefaultOverlapLease();
    const isolated = createOverlapLease();
    setDefaultOverlapLease(isolated);
    try {
      const redis = createFakeRedis({ now: () => 1 });
      let created = 0;
      const lease = ensureDefaultRedisClient({
        env: { NODE_ENV: 'production', REDIS_URL: 'redis://example.invalid' },
        createClient: () => {
          created += 1;
          return redis;
        },
      });
      assert.equal(created, 1);
      assert.equal(lease, isolated);
      assert.equal(lease.snapshot().redisAttached, true);
    } finally {
      setDefaultOverlapLease(previous);
    }
  });

  test('Lua scripts are compare-and-set (GET then DEL/PEXPIRE)', () => {
    assert.match(RENEW_SCRIPT, /GET/);
    assert.match(RENEW_SCRIPT, /PEXPIRE/);
    assert.match(RELEASE_SCRIPT, /GET/);
    assert.match(RELEASE_SCRIPT, /DEL/);
    assert.equal(RENEW_SCRIPT.includes('openclaw'), false);
    assert.equal(RELEASE_SCRIPT.includes('openclaw'), false);
  });
});

describe('scheduler + cron-as-turn wiring', () => {
  test('two cron workers sharing Redis skip the overlapping tick', async () => {
    const previous = getDefaultOverlapLease();
    const clock = createClock();
    const redis = createFakeRedis({ now: clock.now });
    setDefaultOverlapLease(createOverlapLease({ redis, now: clock.now, ttlMs: 5_000 }));
    const cron = require('../src/services/cron-as-turn');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const job = { id: 'cron-lease-shared', userId: 'owner-1', prompt: 'Synthetic overlap lease' };
    try {
      const first = cron.dispatchCronJobAsAgentTurn({ run: () => gate }, job);
      await new Promise((resolve) => setImmediate(resolve));
      const skip = await cron.dispatchCronJobAsAgentTurn({ async run() { return { ok: true }; } }, job);
      assert.equal(skip.error, 'overlap_skipped');
      assert.equal(skip.reason, OVERLAP_HELD_REASON_ES);
      release();
      assert.equal((await first).ok, true);
    } finally {
      setDefaultOverlapLease(previous);
    }
  });

  test('cron overlap copy stays Spanish and vendor-free', async () => {
    const cron = require('../src/services/cron-as-turn');
    assert.equal(cron.OVERLAP_HELD_REASON_ES, OVERLAP_HELD_REASON_ES);
    assert.equal(/OpenClaw|openclaw|Redis|ioredis/.test(cron.OVERLAP_HELD_REASON_ES), false);
  });
});
