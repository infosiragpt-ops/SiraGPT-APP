'use strict';

// Acceptance probe: only a disposable Redis on an isolated loopback network.
// No environment credentials, production queues, model calls or FLUSHDB.
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const Redis = require('ioredis');
const m = require('../src/services/scheduler/overlap-lease');

async function verify() {
  const redis = new Redis('redis://127.0.0.1:6379', {
    lazyConnect: true, maxRetriesPerRequest: 0, enableReadyCheck: false,
    enableOfflineQueue: false, connectTimeout: 250, commandTimeout: 250,
    retryStrategy: () => null,
  });
  redis.on('error', () => {});
  const ownerId = `acceptance-${randomUUID()}`;
  const local = m.createOverlapLease({ ttlMs: 5000 });
  const previous = m.getDefaultOverlapLease();
  m.setDefaultOverlapLease(local);
  let checks = 0;
  try {
    let created = 0;
    const options = { env: { NODE_ENV: 'production', REDIS_URL: 'redis://fixture' },
      createClient: () => { created++; return redis; } };
    m.ensureDefaultRedisClient(options);
    const ready = once(redis, 'ready', { signal: AbortSignal.timeout(5000) });
    const first = await m.acquireJobOverlap({ jobId: 'cold-start', ownerId });
    await ready;
    // The cold-start command cannot enter ioredis's disabled offline queue.
    assert.equal(first.mode, 'local');
    assert.equal(await redis.dbsize(), 0, 'use a fresh disposable Redis only');
    m.ensureDefaultRedisClient(options);
    assert.equal(created, 1);
    const held = await m.acquireJobOverlap({ jobId: 'cold-start', ownerId });
    assert.equal(held.ok, false);
    assert.equal(held.distributed, false);
    assert.equal(await redis.dbsize(), 0);
    await m.releaseJobOverlap(first);
    checks++;

    const current = await m.acquireJobOverlap({ jobId: 'cold-start', ownerId });
    assert.equal(current.mode, 'redis');
    assert.equal(current.distributed, true);
    const contender = m.createOverlapLease({ redis, ttlMs: 5000 });
    assert.equal((await contender.acquire({ jobId: 'cold-start', ownerId })).ok, false);
    checks++;

    const disconnected = once(redis, 'end', { signal: AbortSignal.timeout(5000) });
    redis.disconnect();
    await disconnected;
    const failedOnce = await local.renew(current);
    const failedTwice = await local.renew(current);
    assert.equal(failedOnce.ok, false);
    assert.equal(failedTwice.ok, false);
    await redis.connect();
    const restored = await local.renew(current);
    assert.equal(restored.ok, true);
    assert.equal(restored.mode, 'redis');
    assert.ok((await redis.pttl(current.key)) > 0);
    checks++;

    await redis.pexpire(current.key, 1);
    await delay(20);
    const replacement = await contender.acquire({ jobId: 'cold-start', ownerId });
    assert.equal(replacement.ok, true);
    assert.notEqual(replacement.token, current.token);
    assert.equal((await local.renew(current)).ok, false);
    await local.release(current);
    assert.equal(await redis.get(replacement.key), replacement.token);
    await contender.release(replacement);
    assert.equal(await redis.dbsize(), 0);
    checks++;
  } finally {
    redis.disconnect();
    m.setDefaultOverlapLease(previous);
  }
  return { smoke: 'OVERLAP_REDIS_RECOVERY_OK', checks, paidCalls: 0 };
}

if (require.main === module) {
  verify().then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('OVERLAP_REDIS_RECOVERY_FAILED');
    process.exitCode = 1;
  });
}
module.exports = { verify };
