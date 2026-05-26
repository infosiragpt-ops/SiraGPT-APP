'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { RedisStore } = require('../../src/cache/RedisStore');

function fakeRedis() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v, _ex, _ttl) { store.set(k, v); return 'OK'; },
    async del(k) { return store.delete(k) ? 1 : 0; },
  };
}

test('RedisStore round-trips JSON values with prefix', async () => {
  const r = fakeRedis();
  const s = new RedisStore({ redis: r, prefix: 'p:', ttlSeconds: 60 });
  await s.set('a', { hello: 'world' });
  assert.equal(r.store.has('p:a'), true);
  const v = await s.get('a');
  assert.deepEqual(v, { hello: 'world' });
});

test('RedisStore.get returns undefined on missing keys', async () => {
  const s = new RedisStore({ redis: fakeRedis(), prefix: 'p:' });
  assert.equal(await s.get('nope'), undefined);
});

test('RedisStore.delete returns true when present', async () => {
  const r = fakeRedis();
  const s = new RedisStore({ redis: r, prefix: 'p:' });
  await s.set('a', 1);
  assert.equal(await s.delete('a'), true);
  assert.equal(await s.delete('a'), false);
});

test('RedisStore swallows errors and reports via onError', async () => {
  const errors = [];
  const broken = {
    async get() { throw new Error('boom'); },
    async set() { throw new Error('boom-set'); },
    async del() { throw new Error('boom-del'); },
  };
  const s = new RedisStore({
    redis: broken, prefix: 'p:', onError: (op, e) => errors.push({ op, msg: e.message }),
  });
  assert.equal(await s.get('a'), undefined);
  assert.equal(await s.set('a', 1), false);
  assert.equal(await s.delete('a'), false);
  assert.deepEqual(errors.map((e) => e.op), ['get', 'set', 'del']);
});

test('RedisStore rejects invalid client', () => {
  assert.throws(() => new RedisStore({ redis: null }), TypeError);
  assert.throws(() => new RedisStore({ redis: {} }), TypeError);
});

test('RedisStore.set converts ttlMs → seconds with min 1', async () => {
  const calls = [];
  const r = {
    async get() { return null; },
    async set(k, v, mode, ttl) { calls.push({ k, v, mode, ttl }); return 'OK'; },
    async del() { return 0; },
  };
  const s = new RedisStore({ redis: r, prefix: 'p:', ttlSeconds: 60 });
  await s.set('a', 1, 5_000); // 5s
  await s.set('b', 1, 100);   // <1s, clamped to 1
  await s.set('c', 1);        // default
  assert.equal(calls[0].ttl, 5);
  assert.equal(calls[1].ttl, 1);
  assert.equal(calls[2].ttl, 60);
  assert.equal(calls[0].mode, 'EX');
});
