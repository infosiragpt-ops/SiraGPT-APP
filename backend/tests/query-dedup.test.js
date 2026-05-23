'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createQueryDedup, buildKey, stableStringify } = require('../src/utils/query-dedup');

test('buildKey is stable across key order', () => {
  const a = buildKey('user', { where: { id: 'x', name: 'y' } });
  const b = buildKey('user', { where: { name: 'y', id: 'x' } });
  assert.equal(a, b);
});

test('buildKey differs by model and select', () => {
  assert.notEqual(buildKey('user', { where: { id: 'x' } }), buildKey('session', { where: { id: 'x' } }));
  assert.notEqual(
    buildKey('user', { where: { id: 'x' } }),
    buildKey('user', { where: { id: 'x' }, select: { name: true } }),
  );
});

test('concurrent wrap calls share the same promise', async () => {
  const dedup = createQueryDedup({ ttlMs: 50 });
  let calls = 0;
  const fn = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return calls; };
  const [a, b, c] = await Promise.all([
    dedup.wrap('user', { where: { id: 'x' } }, fn),
    dedup.wrap('user', { where: { id: 'x' } }, fn),
    dedup.wrap('user', { where: { id: 'x' } }, fn),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
});

test('different keys do not share promises', async () => {
  const dedup = createQueryDedup({ ttlMs: 50 });
  let calls = 0;
  const fn = async () => { calls += 1; return calls; };
  await Promise.all([
    dedup.wrap('user', { where: { id: 'a' } }, fn),
    dedup.wrap('user', { where: { id: 'b' } }, fn),
  ]);
  assert.equal(calls, 2);
});

test('after TTL expires, the next call goes to fn again', async () => {
  const dedup = createQueryDedup({ ttlMs: 20 });
  let calls = 0;
  const fn = async () => { calls += 1; return calls; };
  await dedup.wrap('user', { where: { id: 'x' } }, fn);
  await new Promise((r) => setTimeout(r, 50));
  await dedup.wrap('user', { where: { id: 'x' } }, fn);
  assert.equal(calls, 2);
});

test('rejection evicts immediately so retries work', async () => {
  const dedup = createQueryDedup({ ttlMs: 1000 });
  let calls = 0;
  const fn = async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'ok'; };
  await assert.rejects(dedup.wrap('user', { where: { id: 'x' } }, fn));
  const r = await dedup.wrap('user', { where: { id: 'x' } }, fn);
  assert.equal(r, 'ok');
  assert.equal(calls, 2);
});

test('stats track hits and misses', async () => {
  const dedup = createQueryDedup({ ttlMs: 50 });
  await Promise.all([
    dedup.wrap('user', { where: { id: 'x' } }, async () => 1),
    dedup.wrap('user', { where: { id: 'x' } }, async () => 1),
  ]);
  const s = dedup.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

test('stableStringify handles arrays and nulls', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});

test('stableStringify handles Date, BigInt, shared refs and cycles', () => {
  assert.equal(stableStringify(new Date('2026-05-22T00:00:00Z')), '"2026-05-22T00:00:00.000Z"');
  assert.equal(stableStringify({ id: 10n }), '{"id":"10n"}');
  const shared = { a: 1 };
  assert.equal(stableStringify({ x: shared, y: shared }), '{"x":{"a":1},"y":{"a":1}}');
  const circular = { id: 'x' };
  circular.self = circular;
  assert.equal(stableStringify(circular), '{"id":"x","self":"[circular]"}');
});

test('buildKey distinguishes Date filters', () => {
  const a = buildKey('session', { where: { expiresAt: new Date('2026-01-01T00:00:00Z') } });
  const b = buildKey('session', { where: { expiresAt: new Date('2026-01-02T00:00:00Z') } });
  assert.notEqual(a, b);
});

test('ttlMs=0 disables dedup', async () => {
  const dedup = createQueryDedup({ ttlMs: 0 });
  let calls = 0;
  const fn = async () => { calls += 1; return calls; };
  await Promise.all([
    dedup.wrap('user', { where: { id: 'x' } }, fn),
    dedup.wrap('user', { where: { id: 'x' } }, fn),
  ]);
  assert.equal(calls, 2);
});
