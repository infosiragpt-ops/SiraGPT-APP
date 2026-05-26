/**
 * Tests for services/agent-runtime/retriever.js — base retriever class
 * + in-memory lexical retriever.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  BaseRetriever,
  createInMemoryRetriever,
} = require('../src/services/agent-runtime/retriever');

// ── BaseRetriever ─────────────────────────────────────────────────

describe('BaseRetriever', () => {
  it('throws when retrieve is missing', () => {
    assert.throws(
      () => new BaseRetriever({ name: 'r' }),
      /requires retrieve\(query, context\)/,
    );
  });

  it('throws when retrieve is not a function', () => {
    assert.throws(
      () => new BaseRetriever({ name: 'r', retrieve: 'not-a-fn' }),
      /requires retrieve/,
    );
  });

  it('stores name, k, metadata on the instance', () => {
    const r = new BaseRetriever({
      name: 'my-retriever',
      retrieve: async () => [],
      k: 7,
      metadata: { source: 'test' },
    });
    assert.equal(r.name, 'my-retriever');
    assert.equal(r.k, 7);
    assert.deepEqual(r.metadata, { source: 'test' });
  });

  it('defaults k=5', () => {
    const r = new BaseRetriever({ name: 'r', retrieve: async () => [] });
    assert.equal(r.k, 5);
  });

  it('invoke returns [] for empty/whitespace query without calling retrieve', async () => {
    let called = 0;
    const r = new BaseRetriever({
      name: 'r',
      retrieve: async () => { called++; return [{ id: 'x' }]; },
    });
    assert.deepEqual(await r.invoke(''), []);
    assert.deepEqual(await r.invoke('   '), []);
    assert.equal(called, 0, 'retrieve must not be invoked for empty query');
  });

  it('invoke returns [] when query is non-string', async () => {
    const r = new BaseRetriever({
      name: 'r',
      retrieve: async () => [{ id: 'x' }],
    });
    assert.deepEqual(await r.invoke(null), []);
    assert.deepEqual(await r.invoke(42), []);
  });

  it('invoke passes query + context.k to retrieve', async () => {
    let captured;
    const r = new BaseRetriever({
      name: 'r',
      k: 3,
      retrieve: async (q, ctx) => { captured = { q, ctx }; return [{ id: 'd1' }]; },
    });
    await r.invoke('hello world', { userId: 'u1' });
    assert.equal(captured.q, 'hello world');
    assert.equal(captured.ctx.userId, 'u1');
    assert.equal(captured.ctx.k, 3, 'instance k must be injected into context');
  });
});

// ── createInMemoryRetriever ────────────────────────────────────────

describe('createInMemoryRetriever', () => {
  it('returns an empty list when no documents match', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'react native development' },
        { id: 'd2', text: 'kubernetes operators' },
      ],
    });
    const out = await r.invoke('rust borrow checker');
    assert.deepEqual(out, []);
  });

  it('returns matching documents ordered by lexical score', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'react native development' },
        { id: 'd2', text: 'react server components and react ssr' },
        { id: 'd3', text: 'vue composition api' },
      ],
    });
    const out = await r.invoke('react');
    assert.ok(out.length > 0);
    // The doc that mentions react more contextually scores higher;
    // both d1 and d2 contain react. Verify ranking is deterministic
    // and at least one of them is first.
    assert.ok(['d1', 'd2'].includes(out[0].id));
    // d3 must NOT be present (no 'react' token).
    assert.equal(out.some((d) => d.id === 'd3'), false);
  });

  it('respects k as a top-N cap', async () => {
    const docs = [];
    for (let i = 0; i < 10; i++) docs.push({ id: `d${i}`, text: 'react hooks' });
    const r = createInMemoryRetriever({ documents: docs, k: 3 });
    const out = await r.invoke('react');
    assert.equal(out.length, 3);
  });

  it('skips documents with empty text', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'meaningful content here' },
        { id: 'd2', text: '' },
        { id: 'd3', text: '   ' },
        { id: 'd4', text: 'another meaningful doc' },
      ],
    });
    const out = await r.invoke('meaningful');
    assert.equal(out.length, 2);
    const ids = out.map((d) => d.id);
    assert.ok(ids.includes('d1'));
    assert.ok(ids.includes('d4'));
  });

  it('accepts page_content or content as text aliases', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', page_content: 'langchain doc style' },
        { id: 'd2', content: 'alt content style' },
      ],
    });
    const out1 = await r.invoke('langchain');
    assert.equal(out1[0].id, 'd1');
    const out2 = await r.invoke('alt');
    assert.equal(out2[0].id, 'd2');
  });

  it('assigns auto IDs when documents lack one', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { text: 'unique-word-aleph' },
        { text: 'unique-word-bet' },
      ],
    });
    const out = await r.invoke('unique-word-aleph');
    assert.equal(out[0].id, 'doc_1');
  });

  it('preserves metadata on returned documents', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'react hooks', metadata: { tags: ['frontend'], source: 'blog' } },
      ],
    });
    const out = await r.invoke('react');
    assert.deepEqual(out[0].metadata, { tags: ['frontend'], source: 'blog' });
  });

  it('defaults metadata to {} when missing', async () => {
    const r = createInMemoryRetriever({
      documents: [{ id: 'd1', text: 'react hooks' }],
    });
    const out = await r.invoke('react');
    assert.deepEqual(out[0].metadata, {});
  });

  it('returns a score field on each hit (for downstream rerank)', async () => {
    const r = createInMemoryRetriever({
      documents: [{ id: 'd1', text: 'react hooks' }],
    });
    const out = await r.invoke('react');
    assert.ok(out[0].score > 0);
  });

  it('lexical scoring is case- and accent-insensitive', async () => {
    const r = createInMemoryRetriever({
      documents: [{ id: 'd1', text: 'José habló sobre la república' }],
    });
    // Query without accents must still find this doc.
    const out = await r.invoke('jose republica');
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'd1');
  });

  it('multi-token query: doc matching more tokens scores higher', async () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'react' },
        { id: 'd2', text: 'react native hooks' },
      ],
    });
    const out = await r.invoke('react native');
    // d2 contains both tokens of the query; d1 has only one.
    assert.equal(out[0].id, 'd2');
  });

  it('instance k overrides any caller-supplied context.k (pin)', async () => {
    // BaseRetriever spreads {...context, k} when handing off to the
    // retrieve fn, so the instance k always wins. This pins that
    // behavior — a caller hoping to override k at invoke-time must
    // construct a new retriever instead.
    const docs = [];
    for (let i = 0; i < 5; i++) docs.push({ id: `d${i}`, text: 'react' });
    const r = createInMemoryRetriever({ documents: docs, k: 5 });
    const out = await r.invoke('react', { k: 2 });
    assert.equal(out.length, 5, 'instance k=5 must win over caller-provided k=2');
  });

  it('records document_count in retriever metadata', () => {
    const r = createInMemoryRetriever({
      documents: [
        { id: 'd1', text: 'a' },
        { id: 'd2', text: 'b' },
        { id: 'd3', text: '' }, // filtered out
      ],
    });
    assert.equal(r.metadata.document_count, 2);
  });

  it('default name is "in_memory_retriever"', () => {
    const r = createInMemoryRetriever({ documents: [] });
    assert.equal(r.name, 'in_memory_retriever');
  });
});
