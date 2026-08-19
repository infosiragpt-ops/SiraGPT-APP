'use strict';

/**
 * Chaos: Redis down — integration smoke.
 *
 * The rate-limit store has an explicit "use memory" path when REDIS_URL is
 * absent (already covered in `tests/sliding-window-rate-limiter.test.js`).
 *
 * This smoke also forces the *redis path* and proves the fallback fires
 * when the redis client itself throws on every call. The contract: the
 * caller never sees an error, the response shape is identical, and the
 * counter is honored from in-memory state.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

const rl = require('../../src/middleware/rate-limit-store');

function brokenRedis() {
  const err = new Error('redis: connection refused');
  err.code = 'ECONNREFUSED';
  // rate-limit-store calls redis.multi().zremrangebyscore(...).zadd(...).
  // .zcard(...).pexpire(...).exec(). Throwing from .exec is the realistic
  // failure (a queued pipeline that fails on flush).
  const chain = {
    zremrangebyscore() { return chain; },
    zadd() { return chain; },
    zcard() { return chain; },
    pexpire() { return chain; },
    exec() { return Promise.reject(err); },
  };
  return { multi() { return chain; } };
}

describe('chaos: Redis down -> memory fallback', () => {
  beforeEach(() => rl._resetForTests());

  it('falls back to memory when redis exec rejects', async () => {
    // Force the redis path by pretending REDIS_URL is set, then inject the
    // broken client via opts.redis so we never touch a real network.
    const env = { REDIS_URL: 'redis://chaos.invalid:6379' };
    const result = await rl.consume('chaos:key:1', 3, 60_000, {
      env,
      redis: brokenRedis(),
    });
    assert.equal(result.allowed, true);
    assert.equal(typeof result.remaining, 'number');
    assert.ok(result.resetAt instanceof Date);
  });

  it('enforces the limit purely from memory once redis is dead', async () => {
    const env = { REDIS_URL: 'redis://chaos.invalid:6379' };
    const redis = brokenRedis();
    const opts = { env, redis };
    // First two should pass, third should be denied — limit = 2.
    const a = await rl.consume('chaos:key:2', 2, 60_000, opts);
    const b = await rl.consume('chaos:key:2', 2, 60_000, opts);
    const c = await rl.consume('chaos:key:2', 2, 60_000, opts);
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(c.allowed, false);
    assert.equal(c.remaining, 0);
  });

  it('memory-mode (no REDIS_URL) behaves identically', async () => {
    const env = {};
    const a = await rl.consume('chaos:key:3', 1, 60_000, { env });
    const b = await rl.consume('chaos:key:3', 1, 60_000, { env });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, false);
  });
});
