/**
 * Tests for cache/RedisStore.js — L2 Redis cache wrapper.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  RedisStore,
  createRedisStore,
  DEFAULT_PREFIX,
  DEFAULT_TTL_SECONDS,
} = require('../src/cache/RedisStore');

function makeFakeRedis() {
  const data = new Map();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); return 'OK'; },
    async del(k) { const had = data.delete(k); return had ? 1 : 0; },
  };
}

// ── constants ────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_PREFIX = "sira:cache:"', () => {
    assert.equal(DEFAULT_PREFIX, 'sira:cache:');
  });

  it('DEFAULT_TTL_SECONDS = 300 (5 min)', () => {
    assert.equal(DEFAULT_TTL_SECONDS, 300);
  });
});

// ── constructor ────────────────────────────────────────────────

describe('RedisStore constructor', () => {
  it('throws when redis is missing or lacks get/set', () => {
    assert.throws(() => new RedisStore({}), TypeError);
    assert.throws(() => new RedisStore({ redis: null }), TypeError);
    assert.throws(() => new RedisStore({ redis: {} }), TypeError);
    assert.throws(() => new RedisStore({ redis: { get: () => {} } }), TypeError);
  });

  it('accepts a redis client with get + set', () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    assert.ok(s);
  });

  it('default prefix = DEFAULT_PREFIX', () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    assert.equal(s._prefix, DEFAULT_PREFIX);
  });

  it('honours custom prefix', () => {
    const s = new RedisStore({ redis: makeFakeRedis(), prefix: 'my:' });
    assert.equal(s._prefix, 'my:');
  });

  it('default ttlSeconds = DEFAULT_TTL_SECONDS', () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    assert.equal(s._ttl, DEFAULT_TTL_SECONDS);
  });

  it('honours custom ttlSeconds', () => {
    const s = new RedisStore({ redis: makeFakeRedis(), ttlSeconds: 60 });
    assert.equal(s._ttl, 60);
  });

  it('onError must be a function to register', () => {
    const s1 = new RedisStore({ redis: makeFakeRedis(), onError: () => {} });
    assert.equal(typeof s1._onError, 'function');
    const s2 = new RedisStore({ redis: makeFakeRedis(), onError: 'not-fn' });
    assert.equal(s2._onError, null);
  });
});

// ── get ────────────────────────────────────────────────────────

describe('RedisStore.get', () => {
  it('returns undefined for missing key', async () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    assert.equal(await s.get('nope'), undefined);
  });

  it('parses JSON value', async () => {
    const redis = makeFakeRedis();
    await redis.set('sira:cache:k1', JSON.stringify({ x: 1, y: 'z' }));
    const s = new RedisStore({ redis });
    assert.deepEqual(await s.get('k1'), { x: 1, y: 'z' });
  });

  it('prepends prefix to the key', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.get = async (k) => { captured = k; return null; };
    const s = new RedisStore({ redis, prefix: 'X:' });
    await s.get('hello');
    assert.equal(captured, 'X:hello');
  });

  it('returns undefined and calls onError on redis failure', async () => {
    const events = [];
    const redis = makeFakeRedis();
    redis.get = async () => { throw new Error('redis down'); };
    const s = new RedisStore({
      redis,
      onError: (op, err) => events.push({ op, msg: err.message }),
    });
    const out = await s.get('k');
    assert.equal(out, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'get');
    assert.equal(events[0].msg, 'redis down');
  });

  it('JSON parse failure returns undefined (corrupt value)', async () => {
    const redis = makeFakeRedis();
    redis.data.set('sira:cache:bad', 'not-json');
    const s = new RedisStore({ redis });
    assert.equal(await s.get('bad'), undefined);
  });

  it('onError thrown inside callback is swallowed (does not double-fault)', async () => {
    const redis = makeFakeRedis();
    redis.get = async () => { throw new Error('x'); };
    const s = new RedisStore({
      redis,
      onError: () => { throw new Error('cb explodes'); },
    });
    // Should still return undefined, not propagate the inner throw.
    assert.equal(await s.get('k'), undefined);
  });
});

// ── set ────────────────────────────────────────────────────────

describe('RedisStore.set', () => {
  it('stores JSON-stringified value with default TTL', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.set = async (k, v, ex, ttl) => { captured = { k, v, ex, ttl }; return 'OK'; };
    const s = new RedisStore({ redis });
    await s.set('k1', { x: 1 });
    assert.equal(captured.k, 'sira:cache:k1');
    assert.equal(captured.v, '{"x":1}');
    assert.equal(captured.ex, 'EX');
    assert.equal(captured.ttl, DEFAULT_TTL_SECONDS);
  });

  it('returns true on success', async () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    const ok = await s.set('k1', 'v');
    assert.equal(ok, true);
  });

  it('returns false and calls onError on redis failure', async () => {
    const events = [];
    const redis = makeFakeRedis();
    redis.set = async () => { throw new Error('redis down'); };
    const s = new RedisStore({
      redis,
      onError: (op) => events.push(op),
    });
    const out = await s.set('k', 'v');
    assert.equal(out, false);
    assert.deepEqual(events, ['set']);
  });

  it('ttlMs converts to seconds (≥1)', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.set = async (_k, _v, _ex, ttl) => { captured = ttl; return 'OK'; };
    const s = new RedisStore({ redis });
    await s.set('k', 'v', 3500);  // 3.5s
    assert.equal(captured, 4);    // round(3.5) = 4
  });

  it('ttlMs < 1000 rounds DOWN to 0 but floor-clamps to 1', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.set = async (_k, _v, _ex, ttl) => { captured = ttl; return 'OK'; };
    const s = new RedisStore({ redis });
    // 400ms → round(0.4) = 0 → max(1, 0) = 1.
    await s.set('k', 'v', 400);
    assert.equal(captured, 1);
  });

  it('non-finite or zero/negative ttlMs falls back to default TTL', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.set = async (_k, _v, _ex, ttl) => { captured = ttl; return 'OK'; };
    const s = new RedisStore({ redis, ttlSeconds: 100 });
    await s.set('k', 'v', 0);
    assert.equal(captured, 100);
    await s.set('k', 'v', -5);
    assert.equal(captured, 100);
    await s.set('k', 'v', NaN);
    assert.equal(captured, 100);
    await s.set('k', 'v');  // undefined
    assert.equal(captured, 100);
  });
});

// ── delete ─────────────────────────────────────────────────────

describe('RedisStore.delete', () => {
  it('returns true when redis.del returned >0', async () => {
    const redis = makeFakeRedis();
    redis.data.set('sira:cache:k1', '"v"');
    const s = new RedisStore({ redis });
    assert.equal(await s.delete('k1'), true);
  });

  it('returns false when key did not exist', async () => {
    const s = new RedisStore({ redis: makeFakeRedis() });
    assert.equal(await s.delete('never-existed'), false);
  });

  it('returns false and calls onError on redis failure', async () => {
    const events = [];
    const redis = makeFakeRedis();
    redis.del = async () => { throw new Error('boom'); };
    const s = new RedisStore({ redis, onError: (op) => events.push(op) });
    assert.equal(await s.delete('k'), false);
    assert.deepEqual(events, ['del']);
  });

  it('prepends prefix to the key', async () => {
    const redis = makeFakeRedis();
    let captured;
    redis.del = async (k) => { captured = k; return 1; };
    const s = new RedisStore({ redis, prefix: 'p:' });
    await s.delete('hello');
    assert.equal(captured, 'p:hello');
  });
});

// ── createRedisStore ──────────────────────────────────────────

describe('createRedisStore', () => {
  it('returns a RedisStore when options.redis is provided', () => {
    const s = createRedisStore({}, { redis: makeFakeRedis() });
    assert.ok(s instanceof RedisStore);
  });

  it('forwards prefix + ttlSeconds + onError options', () => {
    const cb = () => {};
    const s = createRedisStore({}, {
      redis: makeFakeRedis(),
      prefix: 'custom:',
      ttlSeconds: 99,
      onError: cb,
    });
    assert.equal(s._prefix, 'custom:');
    assert.equal(s._ttl, 99);
    assert.strictEqual(s._onError, cb);
  });

  it('returns null when REDIS_URL is unset and no client provided', () => {
    assert.equal(createRedisStore({}), null);
    assert.equal(createRedisStore({ REDIS_URL: '' }), null);
  });

  it('options.redis wins even when REDIS_URL is set', () => {
    const s = createRedisStore(
      { REDIS_URL: 'redis://example' },
      { redis: makeFakeRedis() },
    );
    assert.ok(s instanceof RedisStore);
  });
});

// ── round-trip ─────────────────────────────────────────────────

describe('RedisStore · round-trip', () => {
  it('set → get → delete cycle works with the same prefix', async () => {
    const redis = makeFakeRedis();
    const s = new RedisStore({ redis, prefix: 'sira:cache:' });
    await s.set('user:42', { name: 'Ada' });
    assert.deepEqual(await s.get('user:42'), { name: 'Ada' });
    assert.equal(await s.delete('user:42'), true);
    assert.equal(await s.get('user:42'), undefined);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/cache/RedisStore');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [
      'DEFAULT_PREFIX', 'DEFAULT_TTL_SECONDS',
      'RedisStore', 'createRedisStore',
    ]);
  });
});
