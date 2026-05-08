'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChatKey,
  buildEmbeddingKey,
  shouldBypassChat,
  shouldBypassEmbedding,
  toolsAreIdempotent,
  isCacheEnabled,
  stableStringify,
  getOrCompute,
  _resetSingletonForTests,
} = require('../../src/cache/llm-cache');
const { TwoTier } = require('../../src/cache/TwoTier');

test('isCacheEnabled honors env flag', () => {
  assert.equal(isCacheEnabled({}), false);
  assert.equal(isCacheEnabled({ SIRA_CACHE_ENABLED: 'true' }), true);
  assert.equal(isCacheEnabled({ SIRA_CACHE_ENABLED: '1' }), true);
  assert.equal(isCacheEnabled({ SIRA_CACHE_ENABLED: 'no' }), false);
});

test('stableStringify produces identical output for reordered keys', () => {
  const a = { a: 1, b: { c: 2, d: 3 } };
  const b = { b: { d: 3, c: 2 }, a: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('buildChatKey is order-independent over message content equality', () => {
  const k1 = buildChatKey({
    model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0,
  });
  const k2 = buildChatKey({
    model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0,
  });
  assert.equal(k1, k2);
});

test('buildChatKey separates models', () => {
  const k1 = buildChatKey({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  const k2 = buildChatKey({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.notEqual(k1, k2);
});

test('buildChatKey separates messages', () => {
  const k1 = buildChatKey({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
  const k2 = buildChatKey({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
  assert.notEqual(k1, k2);
});

test('buildEmbeddingKey separates inputs', () => {
  const k1 = buildEmbeddingKey({ model: 'e', input: 'hello' });
  const k2 = buildEmbeddingKey({ model: 'e', input: 'world' });
  assert.notEqual(k1, k2);
});

test('shouldBypassChat triggers on temperature > 0', () => {
  assert.equal(shouldBypassChat({ temperature: 0 }), false);
  assert.equal(shouldBypassChat({ temperature: 0.0 }), false);
  assert.equal(shouldBypassChat({ temperature: 0.7 }), true);
});

test('shouldBypassChat triggers on stream:true, n>1, top_p<1', () => {
  assert.equal(shouldBypassChat({ stream: true }), true);
  assert.equal(shouldBypassChat({ n: 2 }), true);
  assert.equal(shouldBypassChat({ top_p: 0.9 }), true);
});

test('shouldBypassChat triggers on non-idempotent tools', () => {
  assert.equal(shouldBypassChat({
    temperature: 0,
    tools: [{ function: { name: 'send_email' } }],
  }), true);
  assert.equal(shouldBypassChat({
    temperature: 0,
    tools: [{ function: { name: 'get_time' } }],
  }), false);
});

test('shouldBypassChat honors explicit cache:false', () => {
  assert.equal(shouldBypassChat({ temperature: 0, cache: false }), true);
});

test('toolsAreIdempotent: empty list is idempotent', () => {
  assert.equal(toolsAreIdempotent([]), true);
  assert.equal(toolsAreIdempotent(undefined), true);
});

test('shouldBypassEmbedding rejects nullish input', () => {
  assert.equal(shouldBypassEmbedding({ input: 'hi' }), false);
  assert.equal(shouldBypassEmbedding({ input: null }), true);
  assert.equal(shouldBypassEmbedding({ input: 'hi', cache: false }), true);
});

test('getOrCompute bypasses entirely when feature flag is off', async () => {
  _resetSingletonForTests();
  let calls = 0;
  const compute = async () => { calls += 1; return { ok: true }; };
  const out = await getOrCompute({
    kind: 'chat',
    request: { model: 'm', messages: [{ role: 'user', content: 'a' }] },
    compute,
    env: {}, // SIRA_CACHE_ENABLED unset
  });
  assert.deepEqual(out, { ok: true });
  // Calling again still hits compute — no cache wiring at all.
  await getOrCompute({
    kind: 'chat',
    request: { model: 'm', messages: [{ role: 'user', content: 'a' }] },
    compute,
    env: {},
  });
  assert.equal(calls, 2);
});

test('getOrCompute caches when enabled and request is cacheable', async () => {
  _resetSingletonForTests();
  const cache = new TwoTier({ l1MaxEntries: 10, l1TtlMs: 60_000 });
  let calls = 0;
  const compute = async () => { calls += 1; return { reply: `r${calls}` }; };
  const env = { SIRA_CACHE_ENABLED: 'true' };
  const req = { model: 'm', messages: [{ role: 'user', content: 'hello' }], temperature: 0 };
  const a = await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  const b = await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(cache.metrics.l1Hits, 1);
});

test('getOrCompute bypass path increments metrics counter', async () => {
  _resetSingletonForTests();
  const cache = new TwoTier({ l1MaxEntries: 10, l1TtlMs: 60_000 });
  let calls = 0;
  const compute = async () => { calls += 1; return { x: 1 }; };
  const env = { SIRA_CACHE_ENABLED: 'true' };
  const req = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.9 };
  await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  assert.equal(calls, 2);
  assert.equal(cache.metrics.bypasses, 2);
});

test('getOrCompute does not cache nullish results', async () => {
  _resetSingletonForTests();
  const cache = new TwoTier({ l1MaxEntries: 10, l1TtlMs: 60_000 });
  let calls = 0;
  const compute = async () => { calls += 1; return null; };
  const env = { SIRA_CACHE_ENABLED: 'true' };
  const req = { model: 'm', messages: [{ role: 'user', content: 'q' }], temperature: 0 };
  await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  await getOrCompute({ kind: 'chat', request: req, compute, env, cache });
  assert.equal(calls, 2);
  assert.equal(cache.metrics.l1Hits, 0);
});

test('getOrCompute throws on unknown kind', async () => {
  _resetSingletonForTests();
  await assert.rejects(
    () => getOrCompute({
      kind: 'wat', request: {}, compute: async () => 1, env: { SIRA_CACHE_ENABLED: 'true' },
    }),
    TypeError,
  );
});

test('getOrCompute caches embeddings with a long TTL by default', async () => {
  _resetSingletonForTests();
  const cache = new TwoTier({ l1MaxEntries: 10, l1TtlMs: 60_000 });
  let calls = 0;
  const compute = async () => { calls += 1; return { vec: [1, 2, 3] }; };
  const env = { SIRA_CACHE_ENABLED: 'true' };
  const req = { model: 'text-embedding-3-small', input: 'hello' };
  const a = await getOrCompute({ kind: 'embedding', request: req, compute, env, cache });
  const b = await getOrCompute({ kind: 'embedding', request: req, compute, env, cache });
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
