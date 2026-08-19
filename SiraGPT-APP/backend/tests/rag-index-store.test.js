'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createIndexStore,
  createMemoryStore,
  sha256,
  countOverlap,
} = require('../src/services/rag/index-store');

function fakeChunks(n) {
  return Array.from({ length: n }, (_, i) => ({ ord: i, text: `chunk-${i}` }));
}
function fakeEmbeddings(n, seed = 0) {
  return Array.from({ length: n }, (_, i) => [seed + i, seed - i, i / 3]);
}
function pageHashes(parts) {
  return parts.map((p) => sha256(Buffer.from(p)));
}

test('sha256 produces stable hex digest', () => {
  const a = sha256(Buffer.from('hello'));
  const b = sha256(Buffer.from('hello'));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('countOverlap counts position-aligned hash matches', () => {
  assert.equal(countOverlap(['a', 'b', 'c'], ['a', 'b', 'c']), 3);
  assert.equal(countOverlap(['a', 'b', 'c'], ['a', 'X', 'c']), 2);
  assert.equal(countOverlap(['a', 'b'], ['a', 'b', 'c']), 2);
  assert.equal(countOverlap([], ['a']), 0);
});

test('getOrCompute computes on miss and caches on subsequent calls', async () => {
  const store = createIndexStore();
  let calls = 0;
  const computeFn = async () => {
    calls += 1;
    return {
      chunks: fakeChunks(3),
      embeddings: fakeEmbeddings(3),
      embedTokens: 100,
    };
  };

  const r1 = await store.getOrCompute('hash-A', computeFn);
  assert.equal(r1.hit, false);
  assert.equal(r1.computed, true);
  assert.equal(r1.value.chunks.length, 3);
  assert.equal(calls, 1);

  const r2 = await store.getOrCompute('hash-A', computeFn);
  assert.equal(r2.hit, true);
  assert.equal(r2.computed, false);
  assert.equal(calls, 1, 'computeFn must not run on hit');

  const m = store.metrics();
  assert.equal(m.cacheHits, 1);
  assert.equal(m.cacheMisses, 1);
  assert.equal(m.cacheHitRatio, 0.5);
  assert.ok(m.bytesSaved > 0);
  assert.equal(m.embedTokensSaved, 100);
});

test('getOrCompute rejects malformed compute output', async () => {
  const store = createIndexStore();
  await assert.rejects(
    store.getOrCompute('hash-bad', async () => ({ chunks: 'not-an-array' })),
    /chunks\[\] and embeddings\[\]/
  );
  assert.equal(store.metrics().errors, 1);
});

test('getOrCompute validates inputs', async () => {
  const store = createIndexStore();
  await assert.rejects(store.getOrCompute('', async () => ({})), /contentHash/);
  await assert.rejects(store.getOrCompute('hash-X', null), /computeFn/);
});

test('incremental hit when all pageHashes overlap', async () => {
  const store = createIndexStore();
  const ph = pageHashes(['p0', 'p1', 'p2', 'p3']);
  // Seed cache with first version.
  await store.getOrComputeIncremental(
    { contentHash: 'old-hash', pageHashes: ph },
    async () => ({
      chunks: fakeChunks(4),
      embeddings: fakeEmbeddings(4, 10),
      embedTokens: 400,
    })
  );

  // Same pageHashes, different contentHash -> incremental full overlap.
  let computeCalls = 0;
  const result = await store.getOrComputeIncremental(
    { contentHash: 'new-hash', pageHashes: ph },
    async () => { computeCalls += 1; return { chunks: [], embeddings: [] }; }
  );
  assert.equal(computeCalls, 0, 'compute must not run when full overlap');
  assert.equal(result.mode, 'incremental');
  assert.equal(result.hit, true);
  assert.equal(result.reused, 4);
  assert.equal(result.recomputed, 0);
  assert.equal(result.value.chunks.length, 4);
});

test('incremental partial overlap recomputes only missing pages', async () => {
  const store = createIndexStore();
  const original = pageHashes(['p0', 'p1', 'p2', 'p3']);
  await store.getOrComputeIncremental(
    { contentHash: 'orig', pageHashes: original },
    async () => ({
      chunks: fakeChunks(4),
      embeddings: fakeEmbeddings(4, 100),
      embedTokens: 400,
    })
  );

  // Pages 0, 1 unchanged; pages 2, 3 changed.
  const updated = [original[0], original[1], sha256(Buffer.from('p2-new')), sha256(Buffer.from('p3-new'))];

  let captured = null;
  const result = await store.getOrComputeIncremental(
    { contentHash: 'updated', pageHashes: updated },
    async ({ missingPages }) => {
      captured = missingPages.slice();
      return {
        chunks: missingPages.map((m) => ({ ord: m.index, text: `recomputed-${m.index}` })),
        embeddings: missingPages.map((m) => [m.index, 999]),
        embedTokens: 200,
      };
    }
  );

  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((m) => m.index), [2, 3]);

  assert.equal(result.mode, 'incremental');
  assert.equal(result.reused, 2);
  assert.equal(result.recomputed, 2);
  assert.equal(result.value.chunks.length, 4);
  // Reused chunks come from the original cache.
  assert.equal(result.value.chunks[0].text, 'chunk-0');
  assert.equal(result.value.chunks[1].text, 'chunk-1');
  // Recomputed chunks come from the compute callback.
  assert.equal(result.value.chunks[2].text, 'recomputed-2');
  assert.equal(result.value.chunks[3].text, 'recomputed-3');

  const m = store.metrics();
  assert.equal(m.incrementalHits, 1);
  assert.equal(m.incrementalReuseCount, 2);
  assert.equal(m.incrementalRecomputeCount, 2);
  assert.ok(m.embedTokensSaved > 0, 'should record tokens saved by reuse');
});

test('incremental falls back to full compute when no candidate overlaps', async () => {
  const store = createIndexStore();
  let calls = 0;
  const ph = pageHashes(['fresh-1', 'fresh-2']);
  const result = await store.getOrComputeIncremental(
    { contentHash: 'fresh', pageHashes: ph },
    async ({ missingPages, candidate }) => {
      calls += 1;
      assert.equal(candidate, null);
      assert.equal(missingPages.length, 2);
      return {
        chunks: fakeChunks(2),
        embeddings: fakeEmbeddings(2),
        embedTokens: 50,
      };
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.hit, false);
  assert.equal(result.mode, 'full');
});

test('incremental rejects mismatched compute payload sizes', async () => {
  const store = createIndexStore();
  const ph = pageHashes(['x', 'y']);
  await store.getOrComputeIncremental(
    { contentHash: 'seed', pageHashes: ph },
    async () => ({ chunks: fakeChunks(2), embeddings: fakeEmbeddings(2) })
  );
  const ph2 = [ph[0], sha256(Buffer.from('y-new'))];
  await assert.rejects(
    store.getOrComputeIncremental(
      { contentHash: 'broken', pageHashes: ph2 },
      async () => ({ chunks: [{ ord: 0 }, { ord: 1 }, { ord: 2 }], embeddings: [[1], [2], [3]] })
    ),
    /incremental computeFn returned/
  );
});

test('gc removes entries older than ttl', async () => {
  let clock = new Date('2026-01-01T00:00:00Z').getTime();
  const store = createIndexStore({
    ttlMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    now: () => new Date(clock),
  });

  await store.getOrCompute('old', async () => ({
    chunks: fakeChunks(1), embeddings: fakeEmbeddings(1), embedTokens: 1,
  }));

  // Advance 10 days.
  clock += 10 * 24 * 60 * 60 * 1000;

  await store.getOrCompute('new', async () => ({
    chunks: fakeChunks(1), embeddings: fakeEmbeddings(1), embedTokens: 1,
  }));

  const result = await store.gc();
  assert.equal(result.removed, 1, 'old entry should be evicted');

  // Verify old is gone, new is still there.
  const oldHit = await store.getOrCompute('old', async () => ({
    chunks: fakeChunks(2), embeddings: fakeEmbeddings(2), embedTokens: 5,
  }));
  assert.equal(oldHit.hit, false, 'old entry should re-miss after GC');

  const newHit = await store.getOrCompute('new', async () => {
    throw new Error('should not run');
  });
  assert.equal(newHit.hit, true);
});

test('stats reports aggregate counters and recent entries', async () => {
  const store = createIndexStore();
  await store.getOrCompute('a', async () => ({
    chunks: fakeChunks(2), embeddings: fakeEmbeddings(2), embedTokens: 20,
  }));
  await store.getOrCompute('b', async () => ({
    chunks: fakeChunks(3), embeddings: fakeEmbeddings(3), embedTokens: 30,
  }));
  await store.getOrCompute('a', async () => { throw new Error('cached'); });

  const out = await store.stats({ limit: 10 });
  assert.equal(out.entries, 2);
  assert.ok(out.totalBytes > 0);
  assert.equal(out.totalEmbedTokens, 50);
  assert.equal(out.metrics.cacheHits, 1);
  assert.equal(out.metrics.cacheMisses, 2);
  assert.ok(out.recent.length === 2);
});

test('hitCount increments on every cache hit', async () => {
  const backend = createMemoryStore();
  const store = createIndexStore({ store: backend });

  await store.getOrCompute('h1', async () => ({
    chunks: fakeChunks(1), embeddings: fakeEmbeddings(1), embedTokens: 0,
  }));
  await store.getOrCompute('h1', async () => { throw new Error('no'); });
  await store.getOrCompute('h1', async () => { throw new Error('no'); });

  const row = await backend.findByHash('h1');
  assert.equal(row.hitCount, 2);
});
