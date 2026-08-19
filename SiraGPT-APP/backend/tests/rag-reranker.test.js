"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const reranker = require("../src/services/rag/reranker");

test("reranker isEnabled / getPoolSize / getModelName respect env", () => {
  assert.equal(reranker.isEnabled({}), false);
  assert.equal(reranker.isEnabled({ SIRA_RERANK_ENABLED: "1" }), true);
  assert.equal(reranker.getPoolSize({}), reranker.DEFAULT_POOL_SIZE);
  assert.equal(reranker.getPoolSize({ SIRA_RERANK_POOL: "50" }), 50);
  assert.equal(reranker.getModelName({}), reranker.DEFAULT_MODEL);
  assert.equal(reranker.getModelName({ SIRA_RERANK_MODEL: "custom/model" }), "custom/model");
});

test("reranker getRerankerFn: returns null when disabled and not forced", async () => {
  reranker._resetForTests();
  const fn = await reranker.getRerankerFn({});
  assert.equal(fn, null);
});

test("reranker getRerankerFn: uses injected scoreFn (force=true)", async () => {
  reranker._resetForTests();
  const scoreFn = async (query, texts) => texts.map((t, i) => texts.length - i); // descending
  const fn = await reranker.getRerankerFn({ force: true, scoreFn });
  assert.equal(typeof fn, "function");
  const hits = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
    { id: "c", text: "third" },
  ];
  const out = await fn("query", hits);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, "a");
  assert.equal(out[0].score, 3);
  assert.equal(out[2].score, 1);
});

test("reranker getRerankerFn: batches hits", async () => {
  reranker._resetForTests();
  const batches = [];
  const scoreFn = async (query, texts) => {
    batches.push(texts.length);
    return texts.map(() => 1);
  };
  const fn = await reranker.getRerankerFn({ force: true, scoreFn, batch: 2 });
  const hits = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}`, text: `t${i}` }));
  const out = await fn("q", hits);
  assert.equal(out.length, 5);
  assert.deepEqual(batches, [2, 2, 1]);
});

test("reranker getRerankerFn: per-batch failure does not crash whole call", async () => {
  reranker._resetForTests();
  let call = 0;
  const scoreFn = async (q, texts) => {
    call++;
    if (call === 2) throw new Error("transient");
    return texts.map(() => 0.9);
  };
  const fn = await reranker.getRerankerFn({ force: true, scoreFn, batch: 2 });
  const hits = Array.from({ length: 4 }, (_, i) => ({ id: `h${i}`, text: `t${i}` }));
  const out = await fn("q", hits);
  assert.equal(out.length, 4);
  // first batch scored, second fell back to 0
  assert.equal(out[0].score, 0.9);
  assert.equal(out[2].score, 0);
});

test("reranker getRerankerFn: empty hits returns empty without scoring", async () => {
  reranker._resetForTests();
  let called = false;
  const scoreFn = async () => { called = true; return []; };
  const fn = await reranker.getRerankerFn({ force: true, scoreFn });
  const out = await fn("q", []);
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("reranker loadPipeline: returns null gracefully when package missing", async () => {
  // We cannot guarantee absence of @xenova/transformers in the env, but
  // the contract is: loadPipeline never throws. Just check it resolves.
  reranker._resetForTests();
  const result = await reranker.loadPipeline({ model: "Xenova/__nonexistent__/__model__" });
  // Either null (package missing OR model failed) or a pipeline object —
  // both are acceptable here. The important property is "did not throw".
  assert.ok(result === null || typeof result === "function" || typeof result === "object");
});
