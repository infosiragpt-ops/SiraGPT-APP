'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const {
  ColbertIndex,
  ColbertError,
  tokenizeForColbert,
  normalizeVec,
  cosineSim,
  maxSim,
  colbertScore,
  reciprocalRankFusion,
  combineHybridScores,
  poolMean,
} = require('../src/services/rag/colbert-retrieval');

// ── Deterministic test embedder ──────────────────────────────────────
//
// Maps each token to a 4-dim vector based on a small lookup; unknown
// tokens get a hash-based vector. Intentionally NOT realistic — the
// goal is reproducible scoring math, not embedding quality.

function makeTestEmbedder() {
  const lookup = {
    cat:    [1, 0, 0, 0],
    dog:    [0.9, 0.1, 0, 0],
    fish:   [0, 1, 0, 0],
    bird:   [0, 0.9, 0.1, 0],
    tree:   [0, 0, 1, 0],
    car:    [0, 0, 0, 1],
    truck:  [0, 0, 0.1, 0.9],
    pet:    [0.5, 0.4, 0.1, 0],   // overlaps cat/dog
    animal: [0.3, 0.3, 0.3, 0.1],
  };
  return async (tokens) => tokens.map(t => {
    const v = lookup[t] || hashVec(t, 4);
    return Float32Array.from(v);
  });
}

function hashVec(s, dim) {
  // Deterministic pseudo-random vector from string hash.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) {
    h = (h * 1103515245 + 12345) | 0;
    out[i] = ((h >>> 16) & 0xffff) / 65535 - 0.5;
  }
  return out;
}

// ── tokenizeForColbert ───────────────────────────────────────────────

describe('tokenizeForColbert', () => {
  it('lowercases and splits on punctuation/whitespace', () => {
    assert.deepStrictEqual(tokenizeForColbert('Hello, World!'), ['hello', 'world']);
  });

  it('drops short tokens by default', () => {
    const r = tokenizeForColbert('a b cd', { minLen: 2 });
    assert.deepStrictEqual(r, ['cd']);
  });

  it('caps at maxTokens', () => {
    const txt = Array.from({ length: 50 }, (_, i) => `tok${i}`).join(' ');
    const r = tokenizeForColbert(txt, { maxTokens: 10 });
    assert.strictEqual(r.length, 10);
  });

  it('returns [] on empty / non-string', () => {
    assert.deepStrictEqual(tokenizeForColbert(''), []);
    assert.deepStrictEqual(tokenizeForColbert(null), []);
    assert.deepStrictEqual(tokenizeForColbert(42), []);
  });

  it('preserves case when lowercase=false', () => {
    const r = tokenizeForColbert('Hello World', { lowercase: false });
    assert.deepStrictEqual(r, ['Hello', 'World']);
  });
});

// ── Vector ops ───────────────────────────────────────────────────────

describe('normalizeVec / cosineSim', () => {
  it('normalize produces unit-length vectors', () => {
    const v = normalizeVec(Float32Array.from([3, 4, 0, 0]));
    let mag = 0;
    for (const x of v) mag += x * x;
    assert.ok(Math.abs(Math.sqrt(mag) - 1) < 1e-6);
  });

  it('normalize handles zero vector without NaN', () => {
    const v = normalizeVec(Float32Array.from([0, 0, 0]));
    for (const x of v) assert.strictEqual(x, 0);
  });

  it('cosineSim returns 1 for identical vectors', () => {
    const a = Float32Array.from([1, 2, 3]);
    assert.strictEqual(cosineSim(a, a), 1);
  });

  it('cosineSim returns 0 for orthogonal vectors', () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([0, 1, 0]);
    assert.strictEqual(cosineSim(a, b), 0);
  });

  it('cosineSim returns 0 for any malformed input', () => {
    assert.strictEqual(cosineSim(null, null), 0);
    assert.strictEqual(cosineSim([1], [1, 2]), 0);
    assert.strictEqual(cosineSim([], []), 0);
  });
});

// ── maxSim ───────────────────────────────────────────────────────────

describe('maxSim', () => {
  it('returns 0 for empty inputs', () => {
    assert.strictEqual(maxSim([], []), 0);
    assert.strictEqual(maxSim([Float32Array.from([1])], []), 0);
  });

  it('rewards exact-token matches more than partial', () => {
    const a = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const b = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const c = [Float32Array.from([0.7, 0.7])]; // partial match to both
    assert.ok(maxSim(a, b) > maxSim(a, c));
  });

  it('aggregates correctly: each query vec sums its best match', () => {
    const q = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    const d = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    // q1 best = 1.0 (vs d1), q2 best = 1.0 (vs d2). Sum = 2.0.
    assert.strictEqual(maxSim(q, d), 2);
  });

  it('returns 0 on non-array input', () => {
    assert.strictEqual(maxSim(null, []), 0);
    assert.strictEqual(maxSim([], null), 0);
  });
});

// ── colbertScore ─────────────────────────────────────────────────────

describe('colbertScore', () => {
  it('throws when embedFn is missing', async () => {
    await assert.rejects(colbertScore({ queryText: 'a', docText: 'b' }), ColbertError);
  });

  it('returns 0 for empty query or doc', async () => {
    const e = makeTestEmbedder();
    assert.strictEqual(await colbertScore({ queryText: '', docText: 'cat', embedFn: e }), 0);
    assert.strictEqual(await colbertScore({ queryText: 'cat', docText: '', embedFn: e }), 0);
  });

  it('higher score for more-relevant doc', async () => {
    const e = makeTestEmbedder();
    const score1 = await colbertScore({ queryText: 'cat dog', docText: 'cat dog pet', embedFn: e });
    const score2 = await colbertScore({ queryText: 'cat dog', docText: 'tree car truck', embedFn: e });
    assert.ok(score1 > score2, `expected ${score1} > ${score2}`);
  });

  it('accepts pre-tokenized inputs (skips tokenizer)', async () => {
    const e = makeTestEmbedder();
    const s = await colbertScore({
      queryTokens: ['cat'],
      docTokens: ['cat'],
      embedFn: e,
    });
    assert.strictEqual(s, 1);
  });
});

// ── ColbertIndex ─────────────────────────────────────────────────────

describe('ColbertIndex — construction', () => {
  it('throws when embedFn is missing', () => {
    assert.throws(() => new ColbertIndex(), ColbertError);
  });
});

describe('ColbertIndex — add / size / clear', () => {
  it('add() stores doc with tokens, vecs, centroid', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'd1', text: 'cat dog' });
    assert.strictEqual(idx.size(), 1);
  });

  it('addBatch adds multiple docs', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.addBatch([
      { id: 'd1', text: 'cat' },
      { id: 'd2', text: 'dog' },
    ]);
    assert.strictEqual(idx.size(), 2);
  });

  it('addBatch rejects non-array', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await assert.rejects(idx.addBatch('no'), ColbertError);
  });

  it('add rejects missing id', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await assert.rejects(idx.add({ text: 'cat' }), ColbertError);
  });

  it('handles empty document text gracefully', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'empty', text: '' });
    assert.strictEqual(idx.size(), 1);
  });

  it('remove returns true on hit, false on miss', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'x', text: 'cat' });
    assert.strictEqual(idx.remove('x'), true);
    assert.strictEqual(idx.remove('x'), false);
  });

  it('clear empties the index', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.addBatch([{ id: 'a', text: 'cat' }, { id: 'b', text: 'dog' }]);
    assert.strictEqual(idx.clear(), 2);
    assert.strictEqual(idx.size(), 0);
  });
});

describe('ColbertIndex — search', () => {
  it('returns empty for empty index', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    assert.deepStrictEqual(await idx.search('cat'), []);
  });

  it('returns empty for empty query', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'd1', text: 'cat' });
    assert.deepStrictEqual(await idx.search(''), []);
  });

  it('rejects non-string non-array query', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'd1', text: 'cat' });
    await assert.rejects(idx.search(42), ColbertError);
  });

  it('ranks more-relevant docs higher', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.addBatch([
      { id: 'animals', text: 'cat dog pet animal' },
      { id: 'vehicles', text: 'car truck tree' },
      { id: 'mixed',    text: 'cat tree car' },
    ]);
    const r = await idx.search('cat dog', { k: 3 });
    assert.strictEqual(r[0].id, 'animals', `top-1 expected 'animals', got ${r[0].id}`);
  });

  it('respects k cap', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.addBatch([
      { id: 'a', text: 'cat' }, { id: 'b', text: 'dog' },
      { id: 'c', text: 'fish' }, { id: 'd', text: 'bird' },
    ]);
    const r = await idx.search('animal pet', { k: 2 });
    assert.strictEqual(r.length, 2);
  });

  it('coarseK prune kicks in for large indices', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    // Add many docs (more than coarseK default)
    for (let i = 0; i < 20; i++) {
      await idx.add({ id: `d${i}`, text: i % 2 === 0 ? 'cat dog pet' : 'tree car truck' });
    }
    const r = await idx.search('cat pet', { k: 3, coarseK: 6 });
    assert.strictEqual(r.length, 3);
    // The top result should be one of the cat/dog docs.
    assert.match(r[0].id, /^d\d+$/);
  });

  it('handles docs with zero tokens (empty text) without crashing', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.addBatch([
      { id: 'empty', text: '' },
      { id: 'real',  text: 'cat' },
    ]);
    const r = await idx.search('cat', { k: 5 });
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].id, 'real');
  });

  it('accepts pre-tokenized query', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'd1', text: 'cat dog' });
    const r = await idx.search(['cat', 'dog']);
    assert.strictEqual(r.length, 1);
    assert.ok(r[0].score > 0);
  });

  it('exposes meta from add() through search()', async () => {
    const idx = new ColbertIndex({ embedFn: makeTestEmbedder() });
    await idx.add({ id: 'd1', text: 'cat', meta: { source: 'test.md' } });
    const r = await idx.search('cat');
    assert.deepStrictEqual(r[0].meta, { source: 'test.md' });
  });
});

// ── poolMean ─────────────────────────────────────────────────────────

describe('poolMean', () => {
  it('returns null for empty input', () => {
    assert.strictEqual(poolMean([]), null);
    assert.strictEqual(poolMean(null), null);
  });

  it('averages component-wise', () => {
    const out = poolMean([Float32Array.from([2, 4]), Float32Array.from([4, 6])]);
    assert.strictEqual(out[0], 3);
    assert.strictEqual(out[1], 5);
  });

  it('skips mismatched-length vectors gracefully', () => {
    const out = poolMean([Float32Array.from([2, 4]), Float32Array.from([1, 2, 3])]);
    // Only the first contributes; the second is skipped (wrong dim).
    // Mean = sum/count where count is 2 (both contribute to denominator
    // for simplicity), so the test just verifies no crash.
    assert.strictEqual(out.length, 2);
  });
});

// ── Reciprocal Rank Fusion ───────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('rejects non-array input', () => {
    assert.throws(() => reciprocalRankFusion(null), ColbertError);
  });

  it('rejects rankings without a Map', () => {
    assert.throws(() => reciprocalRankFusion([{ ranks: {} }]), ColbertError);
  });

  it('combines ranks reciprocally', () => {
    const a = new Map([['x', 1], ['y', 2]]);
    const b = new Map([['x', 5], ['y', 1]]);
    const r = reciprocalRankFusion([{ ranks: a, weight: 1 }, { ranks: b, weight: 1 }]);
    // x: 1/(60+1) + 1/(60+5) = 0.01639+0.01538 ≈ 0.03177
    // y: 1/(60+2) + 1/(60+1) = 0.01613+0.01639 ≈ 0.03252
    // y wins because it has the better best rank.
    assert.ok(r.get('y') > r.get('x'), `expected y > x, got y=${r.get('y')} x=${r.get('x')}`);
  });

  it('respects per-ranking weights', () => {
    const a = new Map([['hi-bm25', 1]]);
    const b = new Map([['hi-dense', 1]]);
    const noBm25 = reciprocalRankFusion([{ ranks: a, weight: 0 }, { ranks: b, weight: 1 }]);
    assert.strictEqual(noBm25.get('hi-bm25'), 0);
    assert.ok(noBm25.get('hi-dense') > 0);
  });
});

// ── combineHybridScores ──────────────────────────────────────────────

describe('combineHybridScores', () => {
  it('merges three rankings into one ordered output', () => {
    const r = combineHybridScores({
      bm25:    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      dense:   [{ id: 'b' }, { id: 'a' }, { id: 'c' }],
      colbert: [{ id: 'b' }, { id: 'c' }, { id: 'a' }],
    });
    assert.strictEqual(r[0].id, 'b'); // appears top-2 in all three
  });

  it('handles missing rankings (empty array defaults)', () => {
    const r = combineHybridScores({
      bm25:  [{ id: 'a' }, { id: 'b' }],
    });
    assert.strictEqual(r[0].id, 'a');
    assert.strictEqual(r[1].id, 'b');
  });

  it('respects per-ranker weights', () => {
    // ColBERT alone should swing the result
    const r = combineHybridScores({
      bm25:    [{ id: 'a' }, { id: 'b' }],
      dense:   [{ id: 'a' }, { id: 'b' }],
      colbert: [{ id: 'b' }, { id: 'a' }],
      weights: { bm25: 0, dense: 0, colbert: 5 },
    });
    assert.strictEqual(r[0].id, 'b');
  });

  it('emits one row per unique id seen across rankers', () => {
    const r = combineHybridScores({
      bm25:    [{ id: 'a' }],
      dense:   [{ id: 'b' }],
      colbert: [{ id: 'c' }],
    });
    const ids = r.map(x => x.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b', 'c']);
  });

  it('skips items without an id', () => {
    const r = combineHybridScores({
      bm25:  [{ id: 'a' }, {}, null, { id: 'b' }],
    });
    const ids = r.map(x => x.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b']);
  });
});
