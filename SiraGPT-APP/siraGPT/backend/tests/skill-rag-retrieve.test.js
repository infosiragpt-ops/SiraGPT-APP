'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub rag-service before requiring the skill so the skill captures our stub.
const ragPath = require.resolve('../src/services/rag-service');
const realRag = require('../src/services/rag-service');
const realRetrieveWithTrace = realRag.retrieveWithTrace;

const skill = require('../src/skills/rag_retrieve/handler');

test.afterEach(() => {
  realRag.retrieveWithTrace = realRetrieveWithTrace;
});

test('exports an execute function', () => {
  assert.equal(typeof skill.execute, 'function');
});

test('throws when ctx.userId is missing', async () => {
  await assert.rejects(() => skill.execute({ query: 'q' }, {}), /ctx\.userId is required/);
  await assert.rejects(() => skill.execute({ query: 'q' }, null), /ctx\.userId is required/);
  await assert.rejects(() => skill.execute({ query: 'q' }, undefined), /ctx\.userId is required/);
});

test('returns {hits:[], error:"missing query"} when query is empty or non-string', async () => {
  realRag.retrieveWithTrace = async () => { throw new Error('should NOT be called'); };
  for (const q of ['', null, undefined, 42, {}]) {
    const out = await skill.execute({ query: q }, { userId: 'u-1' });
    assert.deepEqual(out, { hits: [], error: 'missing query' });
  }
});

test('forwards userId, collection ("default"), query, and clamped k to rag.retrieveWithTrace', async () => {
  let received = null;
  realRag.retrieveWithTrace = async (...args) => { received = args; return { hits: [{ id: 'doc-1' }] }; };
  const out = await skill.execute({ query: 'hello', k: 5 }, { userId: 'u-1' });
  assert.deepEqual(out, { hits: [{ id: 'doc-1' }] });
  assert.equal(received[0], 'u-1');
  assert.equal(received[1], 'default');
  assert.equal(received[2], 'hello');
  assert.equal(received[3], 5);
  // Last arg is options
  assert.deepEqual(received[4], { useExpansion: true, useHybrid: true, useMMR: true, mmrLambda: 0.72 });
});

test('honours ctx.collection when provided', async () => {
  let received = null;
  realRag.retrieveWithTrace = async (...args) => { received = args; return { hits: [] }; };
  await skill.execute({ query: 'q' }, { userId: 'u-1', collection: 'thesis-2026' });
  assert.equal(received[1], 'thesis-2026');
});

test('defaults k to 4 when not provided', async () => {
  let received = null;
  realRag.retrieveWithTrace = async (...args) => { received = args; return { hits: [] }; };
  await skill.execute({ query: 'q' }, { userId: 'u-1' });
  assert.equal(received[3], 4);
});

test('clamps k to [1, 10]', async () => {
  const captured = [];
  realRag.retrieveWithTrace = async (...args) => { captured.push(args[3]); return { hits: [] }; };
  await skill.execute({ query: 'q', k: 0 }, { userId: 'u-1' });
  assert.equal(captured[0], 4, '0 falls back to DEFAULT_K=4 via || coalescing');
  await skill.execute({ query: 'q', k: 999 }, { userId: 'u-1' });
  assert.equal(captured[1], 10, '999 caps to MAX_K=10');
  await skill.execute({ query: 'q', k: 7 }, { userId: 'u-1' });
  assert.equal(captured[2], 7);
});

test('returns whatever rag.retrieveWithTrace returns verbatim', async () => {
  const expected = { hits: [{ id: 'a' }, { id: 'b' }], trace: { steps: 3 } };
  realRag.retrieveWithTrace = async () => expected;
  const out = await skill.execute({ query: 'q' }, { userId: 'u-1' });
  assert.equal(out, expected);
});

test('propagates errors from rag.retrieveWithTrace (no swallow)', async () => {
  realRag.retrieveWithTrace = async () => { throw new Error('vector store down'); };
  await assert.rejects(() => skill.execute({ query: 'q' }, { userId: 'u-1' }), /vector store down/);
});
