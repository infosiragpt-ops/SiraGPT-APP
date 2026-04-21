/**
 * Pure-helper tests for provider-level parsing. The real HTTP paths
 * are covered by the orchestrator tests (injected retrievers) — here
 * we verify shape primitives so a drift in provider JSON shapes never
 * silently degrades the user-visible results.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  reconstructAbstract,
  normaliseAuthors,
} = require("../src/services/searchBrain/providers");

test("reconstructAbstract: inverts OpenAlex's word→positions map", () => {
  const inv = {
    Melatonin: [0],
    is: [1],
    a: [2],
    hormone: [3],
  };
  assert.equal(reconstructAbstract(inv), "Melatonin is a hormone");
});

test("reconstructAbstract: sparse positions produce clean text (no undefined holes)", () => {
  // "A B" with a missing word between A and B.
  const inv = { A: [0], B: [2] };
  assert.equal(reconstructAbstract(inv), "A B");
});

test("reconstructAbstract: null / non-object → undefined", () => {
  assert.equal(reconstructAbstract(null), undefined);
  assert.equal(reconstructAbstract(undefined), undefined);
  assert.equal(reconstructAbstract({}), undefined);
});

test("normaliseAuthors: accepts OpenAlex + Semantic Scholar + CrossRef shapes", () => {
  const authors = normaliseAuthors([
    { display_name: "A. García" },       // OpenAlex
    { name: "Bob Roe" },                 // Semantic Scholar / DOAJ / PubMed
    { family: "Li", given: "Mei" },      // CrossRef
    "Plain String",                       // fallback
    null,                                 // drop
    {},                                   // drop (no fields)
  ]);
  assert.deepEqual(authors, ["A. García", "Bob Roe", "Li Mei", "Plain String"]);
});

test("normaliseAuthors: empty / non-array → []", () => {
  assert.deepEqual(normaliseAuthors(null), []);
  assert.deepEqual(normaliseAuthors(undefined), []);
  assert.deepEqual(normaliseAuthors([]), []);
});
