"use strict";

/**
 * Embedding ladder: OpenAI → Gemini (1536 via outputDimensionality + L2 norm)
 * with key-rejection memo, sticky vector space, exact-space demand, 1:1
 * length guarantee; RAG degrades to BM25-only instead of aborting; memory
 * extraction rides the failover ladder; health exposes the state.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const keyHealth = require("../src/utils/provider-key-health");

function fakeOpenAiSdk(behaviour) {
  require.cache[require.resolve("openai")] = {
    exports: class FakeOpenAI {
      constructor(opts) { this.opts = opts; this.embeddings = { create: async (body) => behaviour(body, opts) }; }
    },
  };
  delete require.cache[require.resolve("../src/services/embedding-provider")];
  return require("../src/services/embedding-provider");
}

function geminiFetch(dim, calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, n: body.requests.length, dim: body.requests[0].outputDimensionality });
    const embeddings = body.requests.map((r, i) => ({ values: Array.from({ length: r.outputDimensionality }, (_, k) => (k === i % r.outputDimensionality ? 3 : 0)) }));
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ embeddings }) };
  };
}

test.beforeEach(() => keyHealth.clear());

test("key-health memo: rejects only auth errors, re-arms on new key or TTL, cleared by the bridge", () => {
  assert.equal(keyHealth.isInvalidKeyError({ status: 401 }), true);
  assert.equal(keyHealth.isInvalidKeyError({ message: "Incorrect API key provided: sk-…" }), true);
  assert.equal(keyHealth.isInvalidKeyError({ status: 429, message: "rate limit" }), false);
  assert.equal(keyHealth.isInvalidKeyError({ status: 500 }), false);
  keyHealth.markRejected("openai", "sk-dead", { status: 401 }, { SIRAGPT_KEY_REJECT_MEMO_MS: "60000" });
  assert.equal(keyHealth.isRejected("openai", "sk-dead"), true);
  assert.equal(keyHealth.isRejected("openai", "sk-new"), false, "a different key re-arms the provider");
  keyHealth.markRejected("gemini", "g1", { status: 403 }, { SIRAGPT_KEY_REJECT_MEMO_MS: "1000" });
  keyHealth.clear("gemini");
  assert.equal(keyHealth.isRejected("gemini", "g1"), false);
  const bridge = fs.readFileSync(path.join(__dirname, "..", "src", "services", "admin-connections-bridge.js"), "utf8");
  assert.match(bridge, /provider-key-health'\)\.clear\(providerKey\)/);
});

test("ladder: OpenAI 401 → memoised, Gemini serves 1536 L2-normalised vectors, space becomes sticky", async () => {
  const sdkCalls = [];
  const ladder = fakeOpenAiSdk(async (body) => { sdkCalls.push(body); const e = new Error("Incorrect API key provided"); e.status = 401; throw e; });
  ladder.resetForTests();
  const env = { OPENAI_API_KEY: "sk-dead", GEMINI_API_KEY: "g-ok" };
  const gcalls = [];
  const vecs = await ladder.embed(["hola", "mundo"], { targetDim: 1536, env, fetchImpl: geminiFetch(1536, gcalls) });
  assert.equal(vecs.length, 2);
  assert.equal(vecs[0].length, 1536);
  const norm = Math.sqrt(vecs[0].reduce((a, x) => a + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, "Gemini truncated outputs are re-normalised");
  assert.equal(sdkCalls.length, 1);
  assert.equal(gcalls[0].dim, 1536);
  assert.equal(ladder.currentSpace(1536), "gemini:gemini-embedding-001:1536");
  assert.equal(keyHealth.isRejected("openai", "sk-dead"), true);
  // second call: OpenAI is skipped without a round-trip
  await ladder.embed(["otra"], { targetDim: 1536, env, fetchImpl: geminiFetch(1536, gcalls) });
  assert.equal(sdkCalls.length, 1, "memoised rejection: no second OpenAI call");
  assert.equal(gcalls.length, 2);
  const st = ladder.status(env);
  assert.equal(st.providers.openai.rejected, true);
  assert.deepEqual(st.spaces[1536].available, ["gemini"]);
  assert.equal(ladder.isAvailable(1536, env), true);
});

test("ladder: exact space demanded never substitutes; no usable provider throws EmbeddingUnavailableError", async () => {
  const ladder = fakeOpenAiSdk(async () => { const e = new Error("Incorrect API key provided"); e.status = 401; throw e; });
  ladder.resetForTests();
  const env = { OPENAI_API_KEY: "sk-dead", GEMINI_API_KEY: "g-ok" };
  await assert.rejects(
    () => ladder.embed(["x"], { targetDim: 1536, env, space: "openai:text-embedding-3-small:1536", fetchImpl: geminiFetch(1536, []) }),
    (err) => err.code === "EMBEDDING_UNAVAILABLE",
  );
  assert.equal(ladder.isAvailable(1536, { OPENAI_API_KEY: "sk-dead" }), false, "the only key is memoised as rejected");
  await assert.rejects(() => ladder.embed(["x"], { targetDim: 1536, env: {} }), (err) => err.code === "EMBEDDING_UNAVAILABLE" && /no keys configured/.test(err.message));
});

test("ladder: OpenAI serves natively, cache is per space, 1024-dim memory requests use `dimensions`", async () => {
  const bodies = [];
  const ladder = fakeOpenAiSdk(async (body) => { bodies.push(body); return { data: body.input.map((t, i) => ({ index: i, embedding: Array.from({ length: body.dimensions || 1536 }, (_, k) => (k === i ? 1 : 0)) })) }; });
  ladder.resetForTests();
  const env = { OPENAI_API_KEY: "sk-ok" };
  const a = await ladder.embed(["hola", "mundo"], { targetDim: 1536, env });
  assert.equal(a[1].length, 1536);
  const b = await ladder.embed(["hola"], { targetDim: 1536, env });
  assert.equal(bodies.length, 1, "second call served from the space cache");
  assert.equal(b[0], a[0]);
  const m = await ladder.embed(["memoria"], { targetDim: 1024, env });
  assert.equal(m[0].length, 1024);
  assert.equal(bodies[1].dimensions, 1024);
  assert.equal(ladder.currentSpace(1024), "openai:text-embedding-3-small:1024");
  assert.equal(ladder.status(env).cache.hits, 1);
});

test("rag-service: retrieve() degrades to BM25-only when embeddings are unavailable", async () => {
  // Switchable stub: ingest with working embeddings, then the key "dies".
  let dead = false;
  fakeOpenAiSdk(async (body) => {
    if (dead) { const e = new Error("Incorrect API key provided"); e.status = 401; throw e; }
    return { data: body.input.map((t, i) => ({ index: i, embedding: Array.from({ length: 8 }, (_, k) => (k === (t.length + i) % 8 ? 1 : 0)) })) };
  });
  delete require.cache[require.resolve("../src/services/rag-service")];
  const prev = { O: process.env.OPENAI_API_KEY, G: process.env.GEMINI_API_KEY, F: process.env.GOOGLE_GENERATIVE_AI_API_KEY, A: process.env.GOOGLE_AI_API_KEY };
  process.env.OPENAI_API_KEY = "sk-will-die"; delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_GENERATIVE_AI_API_KEY; delete process.env.GOOGLE_AI_API_KEY;
  try {
    const rag = require("../src/services/rag-service");
    const uid = `t-${Date.now()}`;
    const col = "degraded";
    await rag.clear(uid, col);
    await rag.ingest(uid, col, [
      { text: "La política de reembolsos cubre cargos duplicados en 30 días." },
      { text: "Horario de atención de lunes a viernes." },
    ]);
    dead = true;
    const hits = await rag.retrieve(uid, col, "reembolsos cargos duplicados", 2, { useHybrid: true });
    assert.ok(hits.length >= 1, "BM25 pool still answers");
    assert.equal(hits[0].retrievalMode, "bm25_degraded");
    assert.match(hits[0].text, /reembolsos/);
    assert.equal(keyHealth.isRejected("openai", "sk-will-die"), true);
  } finally {
    for (const [k, v] of [["OPENAI_API_KEY", prev.O], ["GEMINI_API_KEY", prev.G], ["GOOGLE_GENERATIVE_AI_API_KEY", prev.F], ["GOOGLE_AI_API_KEY", prev.A]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("memory + health + metrics wiring", () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const ai = read("src/routes/ai.js");
  assert.match(ai, /require\('\.\.\/services\/memory-llm-client'\)\.createMemoryLlmClient\(\)/);
  assert.doesNotMatch(ai, /const memoryOpenAI = new OpenAI\(/);
  const memClient = require("../src/services/memory-llm-client");
  memClient.resetForTests();
  assert.equal(memClient.createMemoryLlmClient({ env: {}, force: true }), null, "no provider → null, callers no-op");
  const c = memClient.createMemoryLlmClient({ env: { DEEPSEEK_API_KEY: "ds-ok" }, force: true });
  assert.ok(c && typeof c.chat.completions.create === "function");
  const sem = read("src/services/memory-semantic.js");
  assert.match(sem, /require\('\.\/embedding-provider'\)\.isAvailable\(1536\)/);
  const store = read("src/services/user-memory-store.js");
  assert.match(store, /provider === 'auto' \|\| provider === 'ladder'/);
  const health = read("src/services/observability/health-check.js");
  assert.match(health, /checks\.push\(checkEmbeddings\(env\)\);/);
  assert.match(health, /name: 'embeddings'/);
  const metrics = read("src/utils/metrics.js");
  for (const m of ["siragpt_embedding_requests_total", "siragpt_embedding_space_switch_total", "siragpt_rag_retrieve_mode_total"]) assert.ok(metrics.includes(`registerCounter('${m}'`), m);
  const ops = read("src/services/rag/operational-runtime.js");
  assert.match(ops, /operational retrieval unavailable/);
});
