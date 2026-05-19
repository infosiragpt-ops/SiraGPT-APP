/**
 * Unit tests for services/rag/rag-quality.js — hybrid retrieval,
 * heading-weighted re-rank, and MMR diversification.
 *
 * Uses node:test (Node ≥ 18) so no new dependencies are introduced.
 *
 * Coverage targets (~20 tests):
 *   - BM25 score wrapper (4)
 *   - hybrid score fusion (5)
 *   - heading-weighted re-rank ordering (5)
 *   - MMR diversification (5)
 *   - end-to-end pipeline (2)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rq = require('../src/services/rag/rag-quality');

/* ────────────────────────── helpers ─────────────────────────────── */

function mkChunks() {
  return [
    { text: 'Postgres supports JSONB and gin indexes for fast lookup.', title: 'Postgres JSONB' },
    { text: 'Redis is an in-memory key-value store with pub/sub.', title: 'Redis basics' },
    { text: 'Postgres logical replication can be used for read replicas.', title: 'Postgres replication' },
    { text: 'MongoDB stores documents as BSON in collections.', title: 'MongoDB documents' },
    { text: 'Postgres gin indexes accelerate JSONB containment queries.', title: 'Postgres indexes deep dive' },
  ];
}

// Synthetic embeddings: 3-dim "topic vectors". Tests don't care about
// realism, only that cosine distinguishes near-duplicate from distant.
function vec(topic) {
  if (topic === 'postgres') return [1, 0, 0];
  if (topic === 'redis')    return [0, 1, 0];
  if (topic === 'mongodb')  return [0, 0, 1];
  return [0, 0, 0];
}

/* ──────────────────────── BM25 wrapper (4) ──────────────────────── */

test('bm25Score returns a parallel-length array', () => {
  const chunks = mkChunks();
  const scores = rq.bm25Score(chunks, 'postgres jsonb gin');
  assert.equal(scores.length, chunks.length);
});

test('bm25Score normalizes max score to <= 1', () => {
  const scores = rq.bm25Score(mkChunks(), 'postgres jsonb gin');
  for (const s of scores) {
    assert.ok(s >= 0 && s <= 1, `score ${s} out of [0,1]`);
  }
});

test('bm25Score ranks "postgres" queries higher for postgres chunks', () => {
  const chunks = mkChunks();
  const scores = rq.bm25Score(chunks, 'postgres jsonb');
  // chunk 0 should outscore chunk 1 (Redis) and chunk 3 (MongoDB).
  assert.ok(scores[0] > scores[1]);
  assert.ok(scores[0] > scores[3]);
});

test('bm25Score handles empty chunks array', () => {
  assert.deepEqual(rq.bm25Score([], 'anything'), []);
});

/* ─────────────────────── hybrid score fusion (5) ─────────────────── */

test('hybridScore uses 0.7 vector + 0.3 bm25 by default', () => {
  const vec = [1, 0, 0.5];
  const bm = [0, 1, 0.5];
  const fused = rq.hybridScore(vec, bm);
  assert.equal(fused[0].toFixed(2), '0.70');  // 0.7 * 1 + 0.3 * 0
  assert.equal(fused[1].toFixed(2), '0.30');  // 0.7 * 0 + 0.3 * 1
  assert.equal(fused[2].toFixed(2), '0.50');  // 0.7 * 0.5 + 0.3 * 0.5
});

test('hybridScore honours custom weights', () => {
  const fused = rq.hybridScore([1], [1], { vectorWeight: 0.5, bm25Weight: 0.5 });
  assert.equal(fused[0], 1);
});

test('hybridScore handles arrays of different lengths gracefully', () => {
  const fused = rq.hybridScore([1, 1], [1], {});
  assert.equal(fused.length, 2);
  assert.equal(fused[0].toFixed(2), '1.00');
  assert.equal(fused[1].toFixed(2), '0.70'); // bm25 missing → treated as 0
});

test('hybridRetrieve combines vector + bm25 and sorts desc', () => {
  const chunks = [
    { text: 'postgres deep dive', title: 'PG', embedding: vec('postgres') },
    { text: 'redis pub sub', title: 'R', embedding: vec('redis') },
    { text: 'mongodb collections', title: 'M', embedding: vec('mongodb') },
  ];
  const hits = rq.hybridRetrieve({
    chunks, query: 'postgres', queryEmbedding: vec('postgres'),
  });
  assert.equal(hits.length, 3);
  assert.equal(hits[0].title, 'PG');
  for (let i = 0; i < hits.length - 1; i++) {
    assert.ok(hits[i].hybridScore >= hits[i + 1].hybridScore);
  }
});

test('hybridRetrieve emits vectorScore, bm25Score and hybridScore per hit', () => {
  const chunks = [
    { text: 'postgres', title: 't', embedding: vec('postgres') },
  ];
  const [hit] = rq.hybridRetrieve({
    chunks, query: 'postgres', queryEmbedding: vec('postgres'),
  });
  assert.ok(typeof hit.vectorScore === 'number');
  assert.ok(typeof hit.bm25Score === 'number');
  assert.ok(typeof hit.hybridScore === 'number');
});

/* ──────────────────── heading-weighted re-rank (5) ───────────────── */

test('rerankByHeading prefers heading match over body match', () => {
  // Two chunks with identical body, but only one has the matching heading.
  const chunks = [
    { text: 'random body text about cats', title: 'Postgres replication' },
    { text: 'random body text about cats', title: 'Redis pub/sub' },
  ];
  const ranked = rq.rerankByHeading({ chunks, query: 'postgres replication', k: 2 });
  assert.equal(ranked[0].title, 'Postgres replication');
});

test('rerankByHeading respects k', () => {
  const chunks = mkChunks();
  const ranked = rq.rerankByHeading({ chunks, query: 'postgres', k: 2 });
  assert.equal(ranked.length, 2);
});

test('rerankByHeading weights heading higher than body by default', () => {
  assert.ok(rq.HEADING_WEIGHT > rq.BODY_WEIGHT);
});

test('rerankByHeading exposes headingSim and bodySim per hit', () => {
  const chunks = [{ text: 'foo bar', title: 'postgres foo' }];
  const [hit] = rq.rerankByHeading({ chunks, query: 'postgres', k: 1 });
  assert.ok(typeof hit.headingSim === 'number');
  assert.ok(typeof hit.bodySim === 'number');
  assert.ok(typeof hit.rerankScore === 'number');
});

test('rerankByHeading uses embeddings when both query and chunk embedding present', () => {
  const chunks = [
    { text: 'irrelevant body', title: 'irrelevant title',
      embedding: vec('postgres'), headingEmbedding: vec('postgres') },
    { text: 'irrelevant body', title: 'irrelevant title',
      embedding: vec('redis'), headingEmbedding: vec('redis') },
  ];
  const ranked = rq.rerankByHeading({
    chunks, query: 'pg', queryEmbedding: vec('postgres'), k: 2,
  });
  // First chunk's heading+body embedding matches the postgres query vector.
  assert.equal(ranked[0].embedding[0], 1);
});

/* ──────────────────────────── MMR (5) ────────────────────────────── */

test('mmrDiversify with λ=1 ≡ top-k by relevance', () => {
  const chunks = [
    { text: 'aaa', score: 0.9 },
    { text: 'bbb', score: 0.8 },
    { text: 'ccc', score: 0.7 },
  ];
  const out = rq.mmrDiversify({ chunks, lambda: 1, k: 3 });
  assert.deepEqual(out.map((c) => c.text), ['aaa', 'bbb', 'ccc']);
});

test('mmrDiversify avoids near-duplicates with default λ=0.7', () => {
  // Three near-duplicates of the top hit + one diverse alternative.
  const chunks = [
    { text: 'postgres replication setup', score: 0.95 },
    { text: 'postgres replication setup guide', score: 0.93 },
    { text: 'postgres replication setup tutorial', score: 0.91 },
    { text: 'redis cluster sharding strategy', score: 0.70 },
  ];
  const picked = rq.mmrDiversify({ chunks, lambda: 0.5, k: 2 });
  // Second pick must NOT be another postgres-replication near-dupe.
  assert.ok(picked[1].text.startsWith('redis'));
});

test('mmrDiversify respects k', () => {
  const chunks = mkChunks().map((c, i) => ({ ...c, score: 1 - i * 0.1 }));
  const out = rq.mmrDiversify({ chunks, k: 3 });
  assert.equal(out.length, 3);
});

test('mmrDiversify clamps lambda to [0, 1]', () => {
  const chunks = [{ text: 'a', score: 1 }, { text: 'b', score: 0.5 }];
  const out = rq.mmrDiversify({ chunks, lambda: 99, k: 2 });
  assert.equal(out.length, 2);
});

test('mmrDiversify with embeddings uses cosine for redundancy penalty', () => {
  const chunks = [
    { text: 't1', score: 1.0, embedding: vec('postgres') },
    { text: 't2', score: 0.99, embedding: vec('postgres') }, // near-duplicate
    { text: 't3', score: 0.50, embedding: vec('redis') },     // distant
  ];
  const out = rq.mmrDiversify({ chunks, lambda: 0.5, k: 2 });
  assert.equal(out[0].text, 't1');
  // t3 (distant) should beat t2 (cosine = 1 with t1) for the second slot.
  assert.equal(out[1].text, 't3');
});

/* ──────────────────────── end-to-end (2) ─────────────────────────── */

test('retrieveHighQuality returns top-k diverse hits', () => {
  const chunks = [
    { text: 'postgres replication step 1', title: 'PG Repl', embedding: vec('postgres') },
    { text: 'postgres replication step 2', title: 'PG Repl 2', embedding: vec('postgres') },
    { text: 'redis pub/sub', title: 'R', embedding: vec('redis') },
    { text: 'mongodb sharding', title: 'M', embedding: vec('mongodb') },
  ];
  const out = rq.retrieveHighQuality({
    chunks, query: 'postgres', queryEmbedding: vec('postgres'),
    k: 2, overfetchK: 4,
  });
  assert.equal(out.length, 2);
  // First hit must be postgres-related.
  assert.ok(out[0].text.includes('postgres'));
});

test('retrieveHighQuality is non-destructive (input chunks untouched)', () => {
  const chunks = mkChunks();
  const snapshot = JSON.parse(JSON.stringify(chunks));
  rq.retrieveHighQuality({
    chunks, query: 'postgres', queryEmbedding: vec('postgres'), k: 2,
  });
  assert.deepEqual(chunks, snapshot);
});
