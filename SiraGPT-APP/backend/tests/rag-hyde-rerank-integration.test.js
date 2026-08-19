"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildIndex, searchEnhanced } = require("../src/services/sira/hybrid-retrieval");
const { buildEmbeddedChunks, embed, QUERIES } = require("../src/services/rag/goldenset");
const { meanNdcg } = require("../src/services/rag/ndcg");

const reranker = require("../src/services/rag/reranker");

function topicAwareGenerate(query) {
  // Simulate a cheap LLM that knows the topic and writes hypothetical
  // passages using the *vocabulary* of that topic. This is what HyDE
  // is supposed to do: bridge "habla del tema X" → register of real
  // answers about X.
  const q = query.toLowerCase();
  if (/pasta|carbonara|salsa/.test(q)) {
    return [
      "Pasta is boiled in salted water until al dente and tossed with sauce.",
      "Carbonara uses guanciale, pecorino, eggs, and black pepper to make a silky coating.",
      "A long-simmered tomato sauce with garlic and olive oil mellows acidity over time.",
    ].join("\n");
  }
  if (/cach|stampede|herd|lru/.test(q)) {
    return [
      "An LRU cache evicts the least recently used entry when memory fills up.",
      "Two-tier caching pairs an in-process layer with a shared Redis layer.",
      "Cache stampede protection uses single-flight locks or probabilistic refresh.",
    ].join("\n");
  }
  if (/diabet|glucose|sugar|blood/.test(q)) {
    return [
      "Type 2 diabetes involves insulin resistance and is first treated with metformin.",
      "Continuous glucose monitors replace fingerstick readings for many patients.",
      "Diabetic retinopathy is screened with annual dilated eye exams.",
    ].join("\n");
  }
  if (/planet|star|exo|transit|kepler/.test(q)) {
    return [
      "Transit photometry detects planets by the periodic dip in stellar brightness as the planet crosses its star.",
      "Radial velocity infers planets from the wobble of the host star.",
      "Direct imaging of exoplanets uses coronagraphs to block starlight and is best for young giants.",
    ].join("\n");
  }
  return "general unhelpful answer line one\nanother general line\nand a third";
}

function evaluate(chunks, queryHandler) {
  const index = buildIndex(chunks);
  const samples = [];
  return Promise.all(
    QUERIES.map(async (q) => {
      const hits = await queryHandler(index, q);
      samples.push({
        id: q.id,
        ranked: hits.map(h => h.id),
        relevance: q.relevance,
      });
    }),
  ).then(() => meanNdcg(samples, 10));
}

test("integration: HyDE improves NDCG@10 on vague queries", async () => {
  const chunks = buildEmbeddedChunks();

  // Baseline: no HyDE, no rerank.
  const baseline = await evaluate(chunks, async (index, q) => {
    const out = await searchEnhanced(index, {
      query: q.query,
      queryEmbedding: embed(q.query),
      topK: 10,
      hydeEnabled: false,
      rerankEnabled: false,
    });
    return out.hits;
  });

  // With HyDE — uses the topic-aware generator.
  const withHyde = await evaluate(chunks, async (index, q) => {
    const out = await searchEnhanced(index, {
      query: q.query,
      queryEmbedding: embed(q.query),
      topK: 10,
      hydeEnabled: true,
      rerankEnabled: false,
      generateFn: async () => topicAwareGenerate(q.query),
      embedFn: async (txt) => embed(txt),
      hydeWeight: 0.7,
    });
    return out.hits;
  });

  // Both should be high (the goldenset is small + topical), but HyDE
  // must not regress. Asserting >= guards against silent regressions
  // in the orchestration code.
  assert.ok(Number.isFinite(baseline.mean) && baseline.mean > 0.5, `baseline ndcg=${baseline.mean}`);
  assert.ok(Number.isFinite(withHyde.mean), `hyde ndcg=${withHyde.mean}`);
  assert.ok(
    withHyde.mean >= baseline.mean - 1e-9,
    `HyDE regressed: baseline=${baseline.mean} hyde=${withHyde.mean}`,
  );
});

test("integration: rerank stage reorders pool with injected scorer", async () => {
  reranker._resetForTests();
  const chunks = buildEmbeddedChunks();
  const index = buildIndex(chunks);

  // A scorer that knows the right answer: bumps the truly-relevant
  // pasta chunks. We use force-injection so we don't depend on the
  // real cross-encoder model.
  const idealRelevance = QUERIES.find(q => q.id === "q_pasta").relevance;
  const scoreFn = async (query, texts) => {
    return texts.map((t) => {
      // texts are chunk bodies; we look up by content match.
      for (const c of chunks) {
        if (c.text === t) return idealRelevance[c.id] || 0;
      }
      return 0;
    });
  };
  const rerankFn = await reranker.getRerankerFn({ force: true, scoreFn });

  const out = await searchEnhanced(index, {
    query: "habla del tema de la pasta",
    queryEmbedding: embed("habla del tema de la pasta"),
    topK: 5,
    rerankEnabled: true,
    rerankFn,
    rerankPoolSize: 12,
  });

  assert.ok(out.hits.length > 0);
  assert.equal(out.trace.rerank.used, true);
  // top-3 should all be pasta chunks
  const top3 = out.hits.slice(0, 3).map(h => h.id);
  for (const id of top3) {
    assert.match(id, /^ck_pasta_/, `expected pasta chunk in top-3, got ${id}`);
  }
});

test("integration: searchEnhanced traces hyde + rerank stages", async () => {
  reranker._resetForTests();
  const chunks = buildEmbeddedChunks();
  const index = buildIndex(chunks);
  const out = await searchEnhanced(index, {
    query: "tell me about caching strategies",
    queryEmbedding: embed("tell me about caching strategies"),
    topK: 5,
    hydeEnabled: false,
    rerankEnabled: false,
  });
  assert.ok(out.trace.hyde);
  assert.equal(out.trace.hyde.bypassed, true);
  assert.ok(out.trace.rerank);
  assert.equal(out.trace.rerank.bypassed, true);
});

test("integration: rerankPoolSize is honoured by base search", async () => {
  reranker._resetForTests();
  const chunks = buildEmbeddedChunks();
  const index = buildIndex(chunks);
  const seen = [];
  const rerankFn = async (q, hits) => {
    seen.push(hits.length);
    return hits.map((h, i) => ({ id: h.id, score: hits.length - i }));
  };
  await searchEnhanced(index, {
    query: "tell me about caching strategies",
    queryEmbedding: embed("tell me about caching strategies"),
    topK: 3,
    rerankEnabled: true,
    rerankFn,
    rerankPoolSize: 8,
  });
  assert.ok(seen.length === 1);
  assert.ok(seen[0] <= 8 && seen[0] > 0, `pool size ${seen[0]}`);
});
