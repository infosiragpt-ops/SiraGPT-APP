'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RedisStore, createRedisStore, DEFAULT_PREFIX, DEFAULT_TTL_SECONDS } = require('../src/cache/RedisStore');

function makeFakeRedis(overrides = {}) {
  const store = new Map();
  const calls = { get: [], set: [], del: [] };
  return {
    store, calls,
    async get(k) { calls.get.push(k); return store.get(k) ?? null; },
    async set(k, v, ...rest) { calls.set.push({ k, v, rest }); store.set(k, v); return 'OK'; },
    async del(k) { calls.del.push(k); return store.delete(k) ? 1 : 0; },
    ...overrides,
  };
}

test('exports the documented surface + constants', () => {
  assert.equal(typeof RedisStore, 'function');
  assert.equal(typeof createRedisStore, 'function');
  assert.equal(typeof DEFAULT_PREFIX, 'string');
  assert.equal(typeof DEFAULT_TTL_SECONDS, 'number');
  assert.ok(DEFAULT_TTL_SECONDS > 0);
});

test('constructor throws TypeError when redis client lacks get/set methods', () => {
  assert.throws(() => new RedisStore({}), TypeError);
  assert.throws(() => new RedisStore({ redis: null }), TypeError);
  assert.throws(() => new RedisStore({ redis: { get: () => {} } }), TypeError, 'missing set');
  assert.throws(() => new RedisStore({ redis: { set: () => {} } }), TypeError, 'missing get');
});

test('get returns undefined and never throws when the redis call fails', async () => {
  let captured = null;
  const redis = {
    get: async () => { throw new Error('redis down'); },
    set: async () => 'OK',
  };
  const store = new RedisStore({ redis, onError: (op, err) => { captured = { op, msg: err.message }; } });
  const out = await store.get('a');
  assert.equal(out, undefined);
  assert.equal(captured.op, 'get');
  assert.match(captured.msg, /redis down/);
});

test('get returns the deserialised value when redis responds with JSON', async () => {
  const redis = makeFakeRedis();
  redis.store.set(`${DEFAULT_PREFIX}a`, JSON.stringify({ x: 1, y: [2, 3] }));
  const store = new RedisStore({ redis });
  const out = await store.get('a');
  assert.deepEqual(out, { x: 1, y: [2, 3] });
});

test('get returns undefined when the key is absent', async () => {
  const redis = makeFakeRedis();
  const store = new RedisStore({ redis });
  const out = await store.get('missing');
  assert.equal(out, undefined);
});

test('set writes JSON-encoded payload and applies prefix + default TTL in seconds', async () => {
  const redis = makeFakeRedis();
  const store = new RedisStore({ redis, prefix: 'pref:', ttlSeconds: 30 });
  const ok = await store.set('a', { hello: 'world' });
  assert.equal(ok, true);
  assert.equal(redis.calls.set.length, 1);
  assert.equal(redis.calls.set[0].k, 'pref:a');
  assert.equal(redis.calls.set[0].v, JSON.stringify({ hello: 'world' }));
  // EX + 30s
  assert.deepEqual(redis.calls.set[0].rest, ['EX', 30]);
});

test('set per-call ttlMs is converted to seconds (with floor of 1)', async () => {
  const redis = makeFakeRedis();
  const store = new RedisStore({ redis, ttlSeconds: 60 });
  await store.set('a', 1, 5000); // 5s
  assert.deepEqual(redis.calls.set[0].rest, ['EX', 5]);
  // Sub-second ttlMs floors to 1s
  await store.set('b', 1, 100);
  assert.deepEqual(redis.calls.set[1].rest, ['EX', 1]);
});

test('set returns false when redis throws and emits onError(op="set")', async () => {
  let captured = null;
  const redis = {
    get: async () => null,
    set: async () => { throw new Error('write failed'); },
  };
  const store = new RedisStore({ redis, onError: (op, err) => { captured = { op, msg: err.message }; } });
  const ok = await store.set('a', 1);
  assert.equal(ok, false);
  assert.equal(captured.op, 'set');
});

test('delete returns true when the key existed (DEL >= 1)', async () => {
  const redis = makeFakeRedis();
  redis.store.set(`${DEFAULT_PREFIX}a`, '"x"');
  const store = new RedisStore({ redis });
  const out = await store.delete('a');
  assert.equal(out, true);
});

test('delete returns false when the key was absent (DEL = 0)', async () => {
  const redis = makeFakeRedis();
  const store = new RedisStore({ redis });
  const out = await store.delete('nope');
  assert.equal(out, false);
});

test('delete returns false and emits onError when redis throws', async () => {
  let captured = null;
  const redis = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => { throw new Error('del failed'); },
  };
  const store = new RedisStore({ redis, onError: (op, err) => { captured = { op, msg: err.message }; } });
  const out = await store.delete('a');
  assert.equal(out, false);
  assert.equal(captured.op, 'del');
});

test('createRedisStore returns null when REDIS_URL is unset and no client is supplied', () => {
  const out = createRedisStore({});
  assert.equal(out, null);
});

test('createRedisStore wraps an injected client without requiring REDIS_URL', () => {
  const fakeClient = makeFakeRedis();
  const out = createRedisStore({}, { redis: fakeClient, prefix: 'p:', ttlSeconds: 99 });
  assert.ok(out instanceof RedisStore);
});

test('onError swallowing keeps the request path alive even when the hook itself throws', async () => {
  const redis = {
    get: async () => { throw new Error('get fail'); },
    set: async () => 'OK',
  };
  const store = new RedisStore({ redis, onError: () => { throw new Error('hook fail'); } });
  // Must not propagate the inner hook throw
  const out = await store.get('a');
  assert.equal(out, undefined);
});
