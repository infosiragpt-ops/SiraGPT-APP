"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ndcgAtK, meanNdcg } = require("../src/services/rag/ndcg");

test("ndcg: perfect ranking gives 1.0", () => {
  const ranked = ["a", "b", "c"];
  const rel = { a: 2, b: 1, c: 1 };
  assert.equal(ndcgAtK(ranked, rel, 10), 1);
});

test("ndcg: reversed ranking gives < 1", () => {
  const ranked = ["c", "b", "a"];
  const rel = { a: 2, b: 1, c: 1 };
  const v = ndcgAtK(ranked, rel, 10);
  assert.ok(v > 0 && v < 1, `expected 0 < ${v} < 1`);
});

test("ndcg: irrelevant top result lowers score", () => {
  const goodRanked = ["rel", "noise", "noise2"];
  const badRanked = ["noise", "noise2", "rel"];
  const rel = { rel: 2 };
  const good = ndcgAtK(goodRanked, rel, 10);
  const bad = ndcgAtK(badRanked, rel, 10);
  assert.ok(good > bad);
  assert.equal(good, 1);
});

test("ndcg: NaN when no relevance signal", () => {
  const v = ndcgAtK(["a", "b"], {}, 10);
  assert.ok(Number.isNaN(v));
});

test("ndcg: respects k cutoff", () => {
  const ranked = ["x", "x", "x", "x", "rel"];
  const rel = { rel: 2 };
  const at3 = ndcgAtK(ranked, rel, 3);
  const at5 = ndcgAtK(ranked, rel, 5);
  // rel falls outside top-3 → DCG=0 → 0
  assert.equal(at3, 0);
  assert.ok(at5 > 0);
});

test("meanNdcg: averages over samples, skips NaN", () => {
  const samples = [
    { id: "q1", ranked: ["a"], relevance: { a: 2 } },           // 1.0
    { id: "q2", ranked: ["x", "rel"], relevance: { rel: 1 } },  // < 1
    { id: "q3", ranked: ["y"], relevance: {} },                  // NaN, skipped
  ];
  const out = meanNdcg(samples, 10);
  assert.equal(out.n, 2);
  assert.ok(out.mean > 0 && out.mean <= 1);
  assert.equal(out.per_query.length, 3);
  assert.ok(Number.isNaN(out.per_query[2].ndcg));
});
