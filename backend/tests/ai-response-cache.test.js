'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAiResponseCache,
  createInMemoryStore,
  buildKey,
  shouldCache,
  replayCachedStream,
  clearAllInMemoryStores,
} = require('../src/services/cache/ai-response-cache');

test('buildKey returns null when temperature != 0', () => {
  assert.equal(buildKey({ model: 'gpt-4', userPrompt: 'hi', temperature: 0.7 }), null);
});

test('buildKey returns a stable key for deterministic inputs', () => {
  const a = buildKey({ model: 'gpt-4', systemPrompt: 'sys', userPrompt: 'hi', temperature: 0 });
  const b = buildKey({ model: 'gpt-4', systemPrompt: 'sys', userPrompt: 'hi', temperature: 0 });
  assert.equal(a, b);
  const c = buildKey({ model: 'gpt-4', systemPrompt: 'sys', userPrompt: 'different', temperature: 0 });
  assert.notEqual(a, c);
});

test('shouldCache requires opt-in + temp=0', () => {
  assert.equal(shouldCache({ cacheResponses: true, temperature: 0 }), true);
  assert.equal(shouldCache({ cacheResponses: false, temperature: 0 }), false);
  assert.equal(shouldCache({ cacheResponses: true, temperature: 0.5 }), false);
});

test('set + get roundtrips when conditions are met', async () => {
  const cache = createAiResponseCache({ store: createInMemoryStore({ ttlSeconds: 60 }) });
  const params = { model: 'gpt-4', systemPrompt: '', userPrompt: 'hello', temperature: 0, cacheResponses: true };
  await cache.set(params, { text: 'hi there' });
  const got = await cache.get(params);
  assert.deepEqual(got, { text: 'hi there' });
});

test('cache miss when not opted in', async () => {
  const cache = createAiResponseCache({ store: createInMemoryStore() });
  const params = { model: 'gpt-4', userPrompt: 'hello', temperature: 0, cacheResponses: false };
  await cache.set(params, { text: 'x' });
  assert.equal(await cache.get(params), null);
});

test('replayCachedStream emits chunks in order', async () => {
  const chunks = [];
  await replayCachedStream('hello world this is a streamed response', async (c) => { chunks.push(c); }, {
    chunkChars: 8,
    chunkDelayMs: 0,
  });
  assert.equal(chunks.join(''), 'hello world this is a streamed response');
  assert.ok(chunks.length >= 4);
});

test('replayCachedStream handles empty input', async () => {
  let called = false;
  await replayCachedStream('', async () => { called = true; });
  assert.equal(called, false);
});

test('clearAllInMemoryStores wipes registered in-memory stores', async () => {
  const cache = createAiResponseCache({ store: createInMemoryStore({ ttlSeconds: 60 }) });
  const params = {
    model: 'gpt-4', systemPrompt: '', userPrompt: 'wipe-me',
    temperature: 0, cacheResponses: true,
  };
  await cache.set(params, { text: 'cached' });
  assert.deepEqual(await cache.get(params), { text: 'cached' });
  const result = clearAllInMemoryStores();
  assert.ok(result.stores >= 1);
  assert.ok(result.cleared >= 1);
  assert.equal(await cache.get(params), null);
});
