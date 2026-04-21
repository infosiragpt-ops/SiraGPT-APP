/**
 * Tests for queryDecomposer + llmReranker helpers. LLM fully stubbed.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { decomposeQuery, INTERNAL: DEC_INTERNAL } = require("../src/services/searchBrain/queryDecomposer");
const { rerankResults, INTERNAL: RER_INTERNAL } = require("../src/services/searchBrain/llmReranker");

// ─── decomposer ──────────────────────────────────────────────────────────

test("decomposeQuery: falls back to original when LLM absent", async () => {
  const out = await decomposeQuery({ query: "¿qué efectos tiene la melatonina?" });
  assert.equal(out.length, 1);
  assert.equal(out[0].language, "es"); // ¿ + é
});

test("decomposeQuery: returns validated subqueries when LLM responds correctly", async () => {
  const callLLM = async () => ({
    content: JSON.stringify({
      subqueries: [
        { text: "melatonin sleep disorders", language: "en", rationale: "medical angle" },
        { text: "melatonina trastornos del sueño", language: "es" },
        { text: "circadian rhythm review", language: "en" },
      ],
    }),
  });
  const out = await decomposeQuery({ query: "melatonin sleep", callLLM });
  assert.equal(out.length, 3);
  assert.ok(out.some((q) => q.language === "es"));
  assert.ok(out.some((q) => q.language === "en"));
});

test("decomposeQuery: malformed LLM output → fallback", async () => {
  const out = await decomposeQuery({
    query: "x",
    callLLM: async () => ({ content: "not json" }),
  });
  assert.deepEqual(out, [{ text: "x", language: "en" }]);
});

test("validateSubqueries: drops invalid entries", () => {
  const out = DEC_INTERNAL.validateSubqueries({
    subqueries: [
      { text: "ok", language: "es" },
      { text: "", language: "en" },              // empty text
      { text: "no lang" },                        // missing language
      { text: "bad lang", language: "de" },       // unsupported
      { text: "fine", language: "en" },
    ],
  });
  assert.equal(out.length, 2);
});

test("detectLanguage: accents → es, plain → en", () => {
  assert.equal(DEC_INTERNAL.detectLanguage("título"), "es");
  assert.equal(DEC_INTERNAL.detectLanguage("title"), "en");
  assert.equal(DEC_INTERNAL.detectLanguage("title", "es"), "es");
});

// ─── reranker ────────────────────────────────────────────────────────────

function paper(i = 0, rest = {}) {
  return {
    source: "openalex",
    title: `P${i}`,
    authors: [],
    abstract: `abs ${i}`,
    providerRank: i,
    ...rest,
  };
}

test("rerankResults: no LLM → heuristic sort by provider rank + citations + OA", async () => {
  const pool = [
    paper(0, { providerRank: 5, citationCount: 0, openAccess: false }),
    paper(1, { providerRank: 0, citationCount: 1000, openAccess: true, title: "Winner" }),
  ];
  const r = await rerankResults({ query: "q", results: pool });
  assert.equal(r.reranked, false);
  assert.equal(r.results[0].title, "Winner");
});

test("rerankResults: LLM scores applied and composite wins", async () => {
  const pool = [paper(0, { title: "A" }), paper(1, { title: "B" })];
  const callLLM = async () => ({
    content: JSON.stringify({
      scores: [
        { idx: 1, score: 2, reason: "off-topic" },
        { idx: 2, score: 9, reason: "bullseye" },
      ],
    }),
  });
  const r = await rerankResults({ query: "q", results: pool, callLLM });
  assert.equal(r.reranked, true);
  assert.equal(r.results[0].title, "B");
});

test("validateScores: clamps to [0,10], drops non-numeric", () => {
  const out = RER_INTERNAL.validateScores({
    scores: [
      { idx: 1, score: 99 },   // → 10
      { idx: 2, score: -3 },   // → 0
      { idx: 3, score: "xx" }, // dropped
      { idx: "not-num", score: 5 }, // dropped
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].score, 10);
  assert.equal(out[1].score, 0);
});
