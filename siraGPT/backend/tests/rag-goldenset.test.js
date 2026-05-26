/**
 * Tests for services/rag/goldenset.js — deterministic retrieval eval set.
 */

'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  CHUNKS,
  QUERIES,
  embed,
  buildEmbeddedChunks,
} = require('../src/services/rag/goldenset');

// ── CHUNKS catalog ──────────────────────────────────────────────

describe('CHUNKS catalog', () => {
  it('contains 12 chunks (4 topics × 3 chunks)', () => {
    assert.equal(CHUNKS.length, 12);
  });

  it('covers the 4 documented topics: cooking, software, medicine, astronomy', () => {
    const topics = new Set(CHUNKS.map(c => c.topic));
    assert.deepEqual([...topics].sort(), ['astronomy', 'cooking', 'medicine', 'software']);
  });

  it('every chunk has { id, topic, text }', () => {
    for (const c of CHUNKS) {
      assert.equal(typeof c.id, 'string');
      assert.equal(typeof c.topic, 'string');
      assert.equal(typeof c.text, 'string');
      assert.ok(c.text.length > 0);
    }
  });

  it('chunk ids are unique', () => {
    const ids = CHUNKS.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('each topic has exactly 3 chunks', () => {
    const counts = {};
    for (const c of CHUNKS) counts[c.topic] = (counts[c.topic] || 0) + 1;
    for (const t of ['cooking', 'software', 'medicine', 'astronomy']) {
      assert.equal(counts[t], 3, `topic ${t} count`);
    }
  });
});

// ── QUERIES catalog ─────────────────────────────────────────────

describe('QUERIES catalog', () => {
  it('contains 8 queries (2 per topic: vague + specific)', () => {
    assert.equal(QUERIES.length, 8);
  });

  it('every query has { id, query, relevance }', () => {
    for (const q of QUERIES) {
      assert.equal(typeof q.id, 'string');
      assert.equal(typeof q.query, 'string');
      assert.equal(typeof q.relevance, 'object');
    }
  });

  it('relevance keys reference real chunk ids', () => {
    const chunkIds = new Set(CHUNKS.map(c => c.id));
    for (const q of QUERIES) {
      for (const cid of Object.keys(q.relevance)) {
        assert.ok(chunkIds.has(cid), `${q.id} references unknown chunk ${cid}`);
      }
    }
  });

  it('relevance values are graded labels (1 or 2 only)', () => {
    for (const q of QUERIES) {
      for (const v of Object.values(q.relevance)) {
        assert.ok(v === 1 || v === 2, `${q.id} has invalid label ${v}`);
      }
    }
  });

  it('query ids are unique', () => {
    const ids = QUERIES.map(q => q.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// ── embed · primitives ─────────────────────────────────────────

describe('embed', () => {
  it('returns array of length dim (default 64)', () => {
    const v = embed('hello world');
    assert.equal(v.length, 64);
  });

  it('returns zero-vector for empty / null / non-string input', () => {
    const z = new Array(64).fill(0);
    assert.deepEqual(embed(''), z);
    assert.deepEqual(embed(null), z);
    assert.deepEqual(embed(undefined), z);
    assert.deepEqual(embed(42), z);
  });

  it('deterministic: same text → same vector', () => {
    const a = embed('the quick brown fox');
    const b = embed('the quick brown fox');
    assert.deepEqual(a, b);
  });

  it('case-insensitive (lowercase normalisation)', () => {
    const a = embed('Carbonara');
    const b = embed('CARBONARA');
    const c = embed('carbonara');
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  it('accent-insensitive (NFD strip)', () => {
    const a = embed('café');
    const b = embed('cafe');
    assert.deepEqual(a, b);
  });

  it('skips tokens shorter than 3 chars', () => {
    // "a b ok" should embed the same as "ok" alone.
    const a = embed('a b ok');
    const b = embed('ok');
    assert.deepEqual(a, b);
  });

  it('output is L2-normalised (unit length when non-empty)', () => {
    const v = embed('this is some text content for embedding');
    const sumSq = v.reduce((s, x) => s + x * x, 0);
    assert.ok(Math.abs(sumSq - 1) < 1e-9, `expected unit length, got ${Math.sqrt(sumSq)}`);
  });

  it('honours custom dim', () => {
    const v = embed('hello world', 128);
    assert.equal(v.length, 128);
  });

  it('different texts → different vectors', () => {
    const a = embed('cooking pasta carbonara');
    const b = embed('exoplanet transit photometry');
    assert.notDeepStrictEqual(a, b);
  });

  it('related text produces vectors with positive cosine similarity', () => {
    function cos(a, b) {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot; // both already unit-normalised
    }
    const a = embed('pasta cooking water al dente');
    const b = embed('pasta water boil noodles');
    const c = embed('exoplanet detection transit');
    // a vs b (shared cooking tokens) should be more similar than a vs c.
    const ab = cos(a, b);
    const ac = cos(a, c);
    assert.ok(ab > ac, `expected pasta-pasta sim ${ab} > pasta-astronomy sim ${ac}`);
  });
});

// ── buildEmbeddedChunks ────────────────────────────────────────

describe('buildEmbeddedChunks', () => {
  it('returns one entry per chunk', () => {
    const out = buildEmbeddedChunks();
    assert.equal(out.length, CHUNKS.length);
  });

  it('each entry has { id, text, metadata, embedding }', () => {
    const out = buildEmbeddedChunks();
    for (const e of out) {
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.text, 'string');
      assert.equal(typeof e.metadata, 'object');
      assert.ok(Array.isArray(e.embedding));
      assert.equal(e.embedding.length, 64);
    }
  });

  it('metadata carries topic + source_id', () => {
    const out = buildEmbeddedChunks();
    for (const e of out) {
      assert.equal(typeof e.metadata.topic, 'string');
      assert.equal(e.metadata.source_id, e.id);
    }
  });

  it('honours custom dim', () => {
    const out = buildEmbeddedChunks(128);
    for (const e of out) {
      assert.equal(e.embedding.length, 128);
    }
  });

  it('vectors are L2-normalised', () => {
    const out = buildEmbeddedChunks();
    for (const e of out) {
      const sumSq = e.embedding.reduce((s, x) => s + x * x, 0);
      assert.ok(Math.abs(sumSq - 1) < 1e-9, `${e.id} not unit-length`);
    }
  });

  it('retrieval surfaces a gold chunk in top-3 for a token-direct query', () => {
    // Synthetic hash embedding is token-presence-driven, so it works
    // when the query shares concrete content tokens with the chunk
    // (a vague "habla del tema X" query has no shared tokens with
    // the chunk text and is NOT guaranteed to rank). Pin realistic
    // behavior: token-direct queries hit at least one gold in top-3.
    function cos(a, b) {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot;
    }
    const chunks = buildEmbeddedChunks();
    const q = QUERIES.find(qq => qq.id === 'q_carbonara_specific');
    const qVec = embed(q.query);
    const ranked = chunks
      .map(c => ({ id: c.id, sim: cos(qVec, c.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 3);
    const top3Ids = ranked.map(r => r.id);
    const relevantIds = Object.keys(q.relevance);
    const overlap = top3Ids.filter(id => relevantIds.includes(id));
    assert.ok(overlap.length > 0,
      `expected at least one relevant chunk in top-3, got ${top3Ids.join(', ')}`);
  });
});

// ── module surface ──────────────────────────────────────────────

describe('module surface', () => {
  it('exports the documented public API', () => {
    const mod = require('../src/services/rag/goldenset');
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, ['CHUNKS', 'QUERIES', 'buildEmbeddedChunks', 'embed']);
  });
});
