"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const hyde = require("../src/services/rag/hyde");

test("hyde expandQuery: blends original embedding with hypothetical mean", async () => {
  const queryEmbedding = [1, 0, 0, 0];
  const generateFn = async () => "Pasta is boiled in salted water.\nCarbonara uses guanciale and pecorino.\nA tomato sauce simmers slowly.";
  const embedFn = async (txt) => {
    if (/carbonara/i.test(txt)) return [0, 1, 0, 0];
    if (/tomato/i.test(txt)) return [0, 0, 1, 0];
    return [0, 0, 0, 1];
  };
  const out = await hyde.expandQuery({ query: "pasta", queryEmbedding, generateFn, embedFn, weight: 0.5 });
  assert.equal(out.trace.bypassed, false);
  assert.equal(out.hypotheticals.length, 3);
  assert.equal(out.embedding.length, 4);
  // resulting vector is normalised
  let n = 0;
  for (const x of out.embedding) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-9, "embedding should be unit-normalised");
  // first dimension still has signal from the original query
  assert.ok(out.embedding[0] > 0);
});

test("hyde expandQuery: bypasses for long queries", async () => {
  const long = "x".repeat(250);
  const queryEmbedding = [1, 0, 0, 0];
  let generateCalled = false;
  const generateFn = async () => { generateCalled = true; return "x"; };
  const embedFn = async () => [0, 1, 0, 0];
  const out = await hyde.expandQuery({ query: long, queryEmbedding, generateFn, embedFn });
  assert.equal(out.trace.bypassed, true);
  assert.equal(out.trace.reason, "query_too_long");
  assert.equal(generateCalled, false);
  assert.deepEqual(out.embedding, queryEmbedding);
});

test("hyde expandQuery: gracefully degrades when LLM fails", async () => {
  const queryEmbedding = [1, 0, 0, 0];
  const generateFn = async () => { throw new Error("boom"); };
  const embedFn = async () => [0, 1, 0, 0];
  const out = await hyde.expandQuery({ query: "pasta", queryEmbedding, generateFn, embedFn });
  assert.equal(out.trace.bypassed, true);
  assert.match(out.trace.reason, /^generate_failed:/);
  assert.deepEqual(out.embedding, queryEmbedding);
});

test("hyde expandQuery: drops mismatched-dim hypothetical embeddings", async () => {
  const queryEmbedding = [1, 0, 0, 0];
  const generateFn = async () => "answer one\nanswer two";
  const embedFn = async () => [9, 9, 9]; // wrong dim
  const out = await hyde.expandQuery({ query: "pasta", queryEmbedding, generateFn, embedFn });
  assert.equal(out.trace.bypassed, true);
  assert.equal(out.trace.reason, "embed_dim_mismatch");
});

test("hyde parseHypotheticals: strips bullets and blank lines", () => {
  const raw = "1. first answer here\n- second answer\n\n* third answer line\n";
  const lines = hyde.parseHypotheticals(raw, 3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "first answer here");
  assert.equal(lines[1], "second answer");
  assert.equal(lines[2], "third answer line");
});

test("hyde isEnabled: respects env flag", () => {
  assert.equal(hyde.isEnabled({}), false);
  assert.equal(hyde.isEnabled({ SIRA_HYDE_ENABLED: "1" }), true);
  assert.equal(hyde.isEnabled({ SIRA_HYDE_ENABLED: "true" }), true);
  assert.equal(hyde.isEnabled({ SIRA_HYDE_ENABLED: "off" }), false);
});

test("hyde blend: weight=0 returns original, weight=1 returns hyde", () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  assert.deepEqual(hyde.blend(a, b, 0), [1, 0, 0]);
  assert.deepEqual(hyde.blend(a, b, 1), [0, 1, 0]);
});
