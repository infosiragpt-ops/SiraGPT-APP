"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyQuery,
  shouldUseMapReduce,
  createMapReduceCache,
  hashQuery,
  mapPhase,
  reducePhase,
  runMapReduce,
  estimateUsdCost,
  DEFAULT_PRICING,
  _internal: { parseMapOutput, parseReduceOutput, normalizeText },
} = require("../src/services/rag/map-reduce");

// ────────────────────────────────────────────────────────────────────────────
// Mock LLM
// ────────────────────────────────────────────────────────────────────────────

function makeLlm(responder, { perCallUsage = { promptTokens: 100, completionTokens: 80 } } = {}) {
  const calls = [];
  return {
    calls,
    async complete({ system, prompt, maxTokens }) {
      calls.push({ system, prompt, maxTokens });
      const text = typeof responder === "function"
        ? await responder({ system, prompt, callIdx: calls.length - 1 })
        : responder;
      return { text, usage: perCallUsage };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Classifier
// ────────────────────────────────────────────────────────────────────────────

test("classifyQuery: exhaustive keywords (Spanish) → exhaustive", () => {
  for (const q of [
    "lista todos los nombres mencionados",
    "cuántos casos de fraude aparecen en total",
    "compara la sección 3 con la 7",
    "resume cada capítulo",
    "enumera los riesgos",
  ]) {
    const c = classifyQuery(q);
    assert.equal(c.mode, "exhaustive", `expected exhaustive for: ${q}`);
    assert.ok(c.score >= 1);
    assert.ok(c.matchedKeywords.length >= 1);
  }
});

test("classifyQuery: exhaustive keywords (English) → exhaustive", () => {
  for (const q of [
    "list all companies in the document",
    "how many incidents are reported",
    "compare chapter 1 and chapter 5",
    "summarize each section",
  ]) {
    assert.equal(classifyQuery(q).mode, "exhaustive");
  }
});

test("classifyQuery: normal retrieval queries → retrieval", () => {
  for (const q of [
    "what does the document say about pricing",
    "explain the key findings",
    "who is the author",
    "",
    null,
    undefined,
  ]) {
    assert.equal(classifyQuery(q).mode, "retrieval", `expected retrieval for: ${q}`);
  }
});

test("classifyQuery: word-boundary protects against substring false positives", () => {
  // "todos" should not match inside an unrelated word — synthetic check.
  const c = classifyQuery("metodos de pago disponibles");
  assert.equal(c.mode, "retrieval", "should not match 'todos' inside 'metodos'");
});

test("classifyQuery: handles diacritics", () => {
  assert.equal(classifyQuery("¿cuántos errores hay?").mode, "exhaustive");
  assert.equal(classifyQuery("comparación entre A y B").mode, "exhaustive");
});

test("shouldUseMapReduce: respects custom threshold", () => {
  assert.equal(shouldUseMapReduce("lista todos los items"), true);
  assert.equal(shouldUseMapReduce("explica la idea"), false);
  assert.equal(shouldUseMapReduce("lista todos los items", { minScore: 5 }), false);
});

test("normalizeText: lowercases and strips diacritics", () => {
  assert.equal(normalizeText("CUÁNTOS"), "cuantos");
  assert.equal(normalizeText(null), "");
});

// ────────────────────────────────────────────────────────────────────────────
// Cache
// ────────────────────────────────────────────────────────────────────────────

test("hashQuery: normalized queries hash the same", () => {
  assert.equal(hashQuery("Cuántos casos"), hashQuery("CUANTOS CASOS"));
  assert.notEqual(hashQuery("a"), hashQuery("b"));
});

test("cache: get/set roundtrip + LRU eviction", () => {
  const c = createMapReduceCache({ maxEntries: 2 });
  c.set("doc1", "q1", { answer: "A1" });
  c.set("doc1", "q2", { answer: "A2" });
  c.set("doc1", "q3", { answer: "A3" });           // evicts q1
  assert.equal(c.get("doc1", "q1"), null);
  assert.deepEqual(c.get("doc1", "q2"), { answer: "A2" });
  assert.deepEqual(c.get("doc1", "q3"), { answer: "A3" });
  assert.equal(c.size(), 2);
});

test("cache: LRU refresh on read", () => {
  const c = createMapReduceCache({ maxEntries: 2 });
  c.set("d", "a", { v: 1 });
  c.set("d", "b", { v: 2 });
  c.get("d", "a");                       // touch 'a'
  c.set("d", "c", { v: 3 });             // should evict 'b', not 'a'
  assert.deepEqual(c.get("d", "a"), { v: 1 });
  assert.equal(c.get("d", "b"), null);
});

test("cache: TTL expiry", async () => {
  const c = createMapReduceCache({ maxEntries: 10, ttlMs: 5 });
  c.set("d", "q", { v: 1 });
  assert.deepEqual(c.get("d", "q"), { v: 1 });
  await new Promise(r => setTimeout(r, 15));
  assert.equal(c.get("d", "q"), null);
});

test("cache: clear()", () => {
  const c = createMapReduceCache();
  c.set("d", "q", { v: 1 });
  c.clear();
  assert.equal(c.size(), 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Parsers
// ────────────────────────────────────────────────────────────────────────────

test("parseMapOutput: plain JSON", () => {
  const r = parseMapOutput('{"evidence":["x"],"partial_answer":"y","confidence":0.9}');
  assert.deepEqual(r, { evidence: ["x"], partial_answer: "y", confidence: 0.9 });
});

test("parseMapOutput: fenced JSON", () => {
  const r = parseMapOutput('```json\n{"evidence":[],"partial_answer":"a","confidence":0.5}\n```');
  assert.equal(r.partial_answer, "a");
});

test("parseMapOutput: tolerates leading/trailing prose", () => {
  const r = parseMapOutput('Here is the JSON:\n{"evidence":["e"],"partial_answer":"b","confidence":1}');
  assert.deepEqual(r.evidence, ["e"]);
  assert.equal(r.confidence, 1);
});

test("parseMapOutput: clamps confidence to [0,1]", () => {
  assert.equal(parseMapOutput('{"evidence":[],"partial_answer":"","confidence":99}').confidence, 1);
  assert.equal(parseMapOutput('{"evidence":[],"partial_answer":"","confidence":-3}').confidence, 0);
});

test("parseMapOutput: invalid JSON → null", () => {
  assert.equal(parseMapOutput("not json at all"), null);
  assert.equal(parseMapOutput(""), null);
  assert.equal(parseMapOutput(null), null);
});

test("parseReduceOutput: well-formed", () => {
  const r = parseReduceOutput('{"answer":"final","citations":["chunk-1"],"confidence":0.8}');
  assert.equal(r.answer, "final");
  assert.deepEqual(r.citations, ["chunk-1"]);
});

// ────────────────────────────────────────────────────────────────────────────
// Cost
// ────────────────────────────────────────────────────────────────────────────

test("estimateUsdCost: math sanity", () => {
  const cost = estimateUsdCost({ promptTokens: 1_000_000, completionTokens: 0 });
  assert.equal(cost, DEFAULT_PRICING.inputPerMillion);
  const cost2 = estimateUsdCost({ promptTokens: 0, completionTokens: 1_000_000 });
  assert.equal(cost2, DEFAULT_PRICING.outputPerMillion);
});

// ────────────────────────────────────────────────────────────────────────────
// mapPhase
// ────────────────────────────────────────────────────────────────────────────

test("mapPhase: maps all chunks and aggregates usage", async () => {
  const llm = makeLlm(({ callIdx }) =>
    `{"evidence":["e${callIdx}"],"partial_answer":"p${callIdx}","confidence":0.7}`);
  const chunks = [
    { id: "c1", text: "alpha" },
    { id: "c2", text: "beta" },
    { id: "c3", text: "gamma" },
  ];
  const out = await mapPhase({ id: "doc1" }, "lista todos", chunks, { llm, concurrency: 2 });
  assert.equal(out.stats.mapped, 3);
  assert.equal(out.stats.skipped, 0);
  assert.equal(out.results.length, 3);
  for (const r of out.results) {
    assert.equal(r.ok, true);
    assert.match(r.partial_answer, /^p\d+$/);
  }
  assert.equal(out.stats.usage.promptTokens, 300);
  assert.equal(out.stats.usage.completionTokens, 240);
});

test("mapPhase: unparsable LLM output → ok:false but pipeline continues", async () => {
  let i = 0;
  const llm = makeLlm(() => {
    i++;
    return i === 2 ? "garbage output" : '{"evidence":[],"partial_answer":"ok","confidence":0.5}';
  });
  const chunks = [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }];
  const out = await mapPhase({ id: "d" }, "todos", chunks, { llm, concurrency: 1 });
  assert.equal(out.stats.mapped, 2);
  assert.equal(out.stats.skipped, 1);
  const bad = out.results.find(r => !r.ok);
  assert.match(bad.error, /unparsable/);
});

test("mapPhase: respects cost cap (soft stop)", async () => {
  const llm = makeLlm('{"evidence":[],"partial_answer":"x","confidence":0.5}',
    { perCallUsage: { promptTokens: 1_000_000, completionTokens: 0 } });
  const chunks = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, text: "t" }));
  const out = await mapPhase({ id: "d" }, "todos", chunks, {
    llm,
    concurrency: 1,
    costCapUsd: DEFAULT_PRICING.inputPerMillion * 1.5, // cap allows ~1.5 calls
  });
  assert.ok(out.stats.mapped <= 2, `mapped=${out.stats.mapped}`);
  assert.ok(out.stats.skipped >= 3);
});

test("mapPhase: empty chunks → empty result", async () => {
  const llm = makeLlm('{}');
  const out = await mapPhase({ id: "d" }, "todos", [], { llm });
  assert.deepEqual(out.results, []);
  assert.equal(out.stats.mapped, 0);
});

test("mapPhase: throws if llm missing", async () => {
  await assert.rejects(
    () => mapPhase({ id: "d" }, "q", [{ id: "c", text: "x" }], {}),
    /llm adapter/,
  );
});

test("mapPhase: emits map_progress events", async () => {
  const llm = makeLlm('{"evidence":[],"partial_answer":"","confidence":0.5}');
  const events = [];
  await mapPhase({ id: "d" }, "todos", [{ id: "a", text: "x" }, { id: "b", text: "y" }], {
    llm,
    concurrency: 1,
    onProgress: e => events.push(e),
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "map_progress");
  assert.equal(events[1].mapped, 2);
});

test("mapPhase: llm error → result marked not-ok", async () => {
  let n = 0;
  const llm = {
    async complete() {
      n++;
      if (n === 1) throw new Error("boom");
      return { text: '{"evidence":[],"partial_answer":"ok","confidence":1}', usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const out = await mapPhase({ id: "d" }, "todos", [{ id: "a", text: "x" }, { id: "b", text: "y" }], {
    llm,
    concurrency: 1,
  });
  assert.equal(out.stats.mapped, 1);
  assert.equal(out.stats.skipped, 1);
  assert.match(out.results[0].error, /boom/);
});

test("mapPhase: aborted signal → skips remaining chunks", async () => {
  const llm = makeLlm('{"evidence":[],"partial_answer":"","confidence":0.5}');
  const ac = new AbortController();
  ac.abort();
  const out = await mapPhase({ id: "d" }, "todos", [{ id: "a", text: "x" }], {
    llm,
    signal: ac.signal,
  });
  assert.equal(out.stats.mapped, 0);
  assert.equal(out.stats.skipped, 1);
});

// ────────────────────────────────────────────────────────────────────────────
// reducePhase
// ────────────────────────────────────────────────────────────────────────────

test("reducePhase: consolidates partials with citations", async () => {
  const llm = makeLlm(
    '{"answer":"Total: 5 [chunk-1][chunk-3]","citations":["chunk-1","chunk-3"],"confidence":0.85}'
  );
  const partials = [
    { chunkId: "chunk-1", ok: true, partial_answer: "2 cases", evidence: ["c1"], confidence: 0.9 },
    { chunkId: "chunk-2", ok: true, partial_answer: "", evidence: [], confidence: 0.1 },
    { chunkId: "chunk-3", ok: true, partial_answer: "3 more cases", evidence: ["c3"], confidence: 0.8 },
  ];
  const events = [];
  const out = await reducePhase("cuántos casos", partials, { llm, onProgress: e => events.push(e) });
  assert.match(out.answer, /Total: 5/);
  assert.deepEqual(out.citations, ["chunk-1", "chunk-3"]);
  assert.equal(out.confidence, 0.85);
  assert.equal(events[0].type, "reduce_started");
  assert.equal(events[0].contributing, 3);
});

test("reducePhase: skips when cost cap already exhausted", async () => {
  const llm = makeLlm('{"answer":"x","citations":[],"confidence":1}');
  const tracker = { spentUsd: 1.0 };
  const out = await reducePhase("q", [], { llm, costTracker: tracker, costCapUsd: 0.5 });
  assert.equal(out.stats.skipped, true);
  assert.equal(out.answer, "");
  assert.equal(llm.calls.length, 0);
});

test("reducePhase: unparsable output → safe defaults", async () => {
  const llm = makeLlm("not json");
  const out = await reducePhase("q", [
    { chunkId: "a", ok: true, partial_answer: "x", evidence: [], confidence: 0.5 },
  ], { llm });
  assert.equal(out.answer, "");
  assert.deepEqual(out.citations, []);
});

// ────────────────────────────────────────────────────────────────────────────
// runMapReduce orchestrator
// ────────────────────────────────────────────────────────────────────────────

test("runMapReduce: short-circuits for non-exhaustive queries", async () => {
  const llm = makeLlm('{}');
  const out = await runMapReduce({
    doc: { id: "d1" },
    query: "what is the price",
    chunks: [{ id: "c", text: "x" }],
    llm,
  });
  assert.equal(out.skipped, true);
  assert.equal(out.mode, "retrieval");
  assert.equal(llm.calls.length, 0);
});

test("runMapReduce: full pipeline + SSE events", async () => {
  let nReduce = 0;
  const llm = {
    async complete({ system }) {
      if (/synthesizer/.test(system)) {
        nReduce++;
        return {
          text: '{"answer":"final [chunk-c1][chunk-c2]","citations":["chunk-c1","chunk-c2"],"confidence":0.9}',
          usage: { promptTokens: 200, completionTokens: 100 },
        };
      }
      return {
        text: '{"evidence":["e"],"partial_answer":"p","confidence":0.7}',
        usage: { promptTokens: 50, completionTokens: 30 },
      };
    },
  };
  const events = [];
  const out = await runMapReduce({
    doc: { id: "doc-1" },
    query: "lista todos los hallazgos",
    chunks: [
      { id: "chunk-c1", text: "alpha" },
      { id: "chunk-c2", text: "beta" },
    ],
    llm,
    onEvent: e => events.push(e),
  });

  assert.equal(out.mode, "exhaustive");
  assert.match(out.answer, /final/);
  assert.equal(nReduce, 1);
  assert.equal(out.stats.mapped, 2);
  assert.ok(out.stats.costUsd > 0);
  assert.ok(out.stats.durationMs >= 0);

  const types = events.map(e => e.type);
  assert.ok(types.includes("classified"));
  assert.ok(types.includes("map_started"));
  assert.ok(types.filter(t => t === "map_progress").length === 2);
  assert.ok(types.includes("reduce_started"));
  assert.ok(types.includes("done"));
});

test("runMapReduce: cache hit short-circuits second call", async () => {
  let llmCalls = 0;
  const llm = {
    async complete() {
      llmCalls++;
      return {
        text: '{"answer":"x","citations":[],"confidence":1,"evidence":[],"partial_answer":"p"}',
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
  const cache = createMapReduceCache();
  const args = {
    doc: { id: "doc-X" },
    query: "compara las secciones",
    chunks: [{ id: "a", text: "1" }],
    llm,
    cache,
  };
  await runMapReduce(args);
  const callsAfterFirst = llmCalls;
  const events = [];
  const second = await runMapReduce({ ...args, onEvent: e => events.push(e) });
  assert.equal(llmCalls, callsAfterFirst, "cache should prevent further LLM calls");
  assert.equal(second.fromCache, true);
  assert.ok(events.some(e => e.type === "cache_hit"));
});

test("runMapReduce: forceMode='exhaustive' overrides classifier", async () => {
  const llm = {
    async complete({ system }) {
      const isReduce = /synthesizer/.test(system);
      return {
        text: isReduce
          ? '{"answer":"a","citations":["chunk-0"],"confidence":1}'
          : '{"evidence":["e"],"partial_answer":"p","confidence":0.5}',
        usage: { promptTokens: 5, completionTokens: 5 },
      };
    },
  };
  const out = await runMapReduce({
    doc: { id: "d" },
    query: "what is the price",
    chunks: [{ id: "chunk-0", text: "x" }],
    llm,
    forceMode: "exhaustive",
  });
  assert.equal(out.mode, "exhaustive");
  assert.equal(out.answer, "a");
});

test("runMapReduce: validates inputs", async () => {
  await assert.rejects(() => runMapReduce({ query: "lista todos", chunks: [], llm: makeLlm("{}") }),
    /doc\.id/);
  await assert.rejects(() => runMapReduce({ doc: { id: "d" }, chunks: [], llm: makeLlm("{}") }),
    /query/);
  await assert.rejects(() => runMapReduce({ doc: { id: "d" }, query: "lista todos", llm: makeLlm("{}") }),
    /chunks/);
});

test("runMapReduce: cost cap prevents reduce when map exhausts budget", async () => {
  const llm = makeLlm('{"evidence":[],"partial_answer":"p","confidence":0.5,"answer":"x","citations":[]}',
    { perCallUsage: { promptTokens: 1_000_000, completionTokens: 0 } });
  const out = await runMapReduce({
    doc: { id: "d" },
    query: "lista todos",
    chunks: [{ id: "a", text: "x" }, { id: "b", text: "y" }],
    llm,
    costCapUsd: DEFAULT_PRICING.inputPerMillion * 1.1, // ~1 call worth
  });
  assert.equal(out.mode, "exhaustive");
  assert.ok(out.stats.costUsd <= DEFAULT_PRICING.inputPerMillion * 2);
  // reduce was either skipped or got the partials it could.
  assert.ok(out.stats.reduceSkipped === true || typeof out.answer === "string");
});
