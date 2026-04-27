/**
 * Tests for UniversalSearchBrain — fully offline (no network).
 *
 * Every provider is stubbed via the in-memory registry so CI is
 * deterministic. The Open-Meteo provider itself hits real HTTP and is
 * exercised in a separate integration test (guarded by OPEN_METEO_LIVE).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classifyIntent, INTERNAL: CI_INTERNAL } = require("../src/services/searchBrain/universal/intentClassifier");
const registry = require("../src/services/searchBrain/universal/providerRegistry");
const settings = require("../src/services/searchBrain/universal/settings");
const { runUniversalSearch, INTERNAL: O_INTERNAL } = require("../src/services/searchBrain/universal/orchestrator");
const { CATEGORIES, REGIONS } = require("../src/services/searchBrain/universal/types");

// ─── Intent classifier ───────────────────────────────────────────────────

test("classifyIntent: weather query", () => {
  assert.deepEqual(classifyIntent("¿cuál es el clima en Lima hoy?"), ["weather"]);
});

test("classifyIntent: jobs query (location is a filter, not a geo intent)", () => {
  const out = classifyIntent("trabajo data scientist en madrid");
  assert.ok(out.includes("jobs"));
});

test("classifyIntent: explicit map query triggers geo", () => {
  const out = classifyIntent("mapa de Lima con coordenadas");
  assert.ok(out.includes("geo"));
});

test("classifyIntent: academic paper query", () => {
  assert.deepEqual(classifyIntent("melatonin circadian rhythm paper"), ["academic"]);
});

test("classifyIntent: empty falls back to web", () => {
  assert.deepEqual(classifyIntent(""), ["web"]);
  assert.deepEqual(classifyIntent("   "), ["web"]);
});

test("classifyIntent: unknown falls back to web", () => {
  assert.deepEqual(classifyIntent("foo bar baz"), ["web"]);
});

test("classifyIntent: respects fallback param", () => {
  assert.deepEqual(classifyIntent("foo bar", { fallback: ["academic"] }), ["academic"]);
});

test("classifyIntent: chinese keyword triggers china", () => {
  assert.ok(classifyIntent("baidu 搜索").includes("china"));
});

test("classifyIntent: PATTERNS cover every category except web", () => {
  for (const c of CATEGORIES) {
    if (c === "web") continue;
    assert.ok(CI_INTERNAL.PATTERNS[c], `missing pattern for ${c}`);
  }
});

// ─── Registry ────────────────────────────────────────────────────────────

function stubProvider(overrides = {}) {
  return {
    id: "stub",
    name: "Stub",
    region: "global",
    category: "web",
    license: "open",
    rateLimit: "n/a",
    requiresKey: false,
    search: async () => [],
    ...overrides,
  };
}

test("registry: register + get", () => {
  registry.clear();
  const p = stubProvider({ id: "s1" });
  registry.register(p);
  assert.equal(registry.get("s1").id, "s1");
  assert.equal(registry.size(), 1);
});

test("registry: rejects unknown category", () => {
  registry.clear();
  assert.throws(() => registry.register(stubProvider({ category: "bogus" })));
});

test("registry: list by category + region includes global fallback", () => {
  registry.clear();
  registry.register(stubProvider({ id: "g-news", region: "global", category: "news" }));
  registry.register(stubProvider({ id: "es-news", region: "spain", category: "news" }));
  registry.register(stubProvider({ id: "lat-news", region: "latam", category: "news" }));
  const esOnly = registry.list({ category: "news", region: "spain" });
  const ids = esOnly.map((p) => p.id).sort();
  assert.deepEqual(ids, ["es-news", "g-news"]);
});

test("registry: listMetadata never exposes search()", () => {
  registry.clear();
  registry.register(stubProvider({ id: "s1" }));
  const meta = registry.listMetadata();
  assert.equal(meta[0].id, "s1");
  assert.equal(typeof meta[0].search, "undefined");
});

// ─── Settings ────────────────────────────────────────────────────────────

test("settings: defaults when user unknown", () => {
  settings.clear();
  const s = settings.get("nobody");
  assert.equal(s.region, "global");
  assert.equal(s.mode, "local");
  assert.deepEqual(s.keys, {});
});

test("settings: update region + keys, unset empty key", () => {
  settings.clear();
  settings.update("u1", { region: "spain", keys: { adzuna: "abc" } });
  assert.equal(settings.get("u1").region, "spain");
  assert.equal(settings.get("u1").keys.adzuna, "abc");
  settings.update("u1", { keys: { adzuna: "" } });
  assert.equal(settings.get("u1").keys.adzuna, undefined);
});

test("settings: publicView hides key values", () => {
  settings.clear();
  settings.update("u2", { keys: { brave: "secret" } });
  const v = settings.publicView("u2");
  assert.deepEqual(v.keysConfigured, ["brave"]);
  assert.equal(v.brave, undefined);
});

test("settings: ignores invalid region/mode", () => {
  settings.clear();
  settings.update("u3", { region: "mars", mode: "offline" });
  assert.equal(settings.get("u3").region, "global");
  assert.equal(settings.get("u3").mode, "local");
});

// ─── Orchestrator ────────────────────────────────────────────────────────

function buildFakeRegistry(providers) {
  return {
    list: ({ category, region }) =>
      providers.filter(
        (p) => p.category === category && (p.region === region || p.region === "global"),
      ),
  };
}

test("runUniversalSearch: routes to weather provider on weather intent", async () => {
  const calls = [];
  const weather = stubProvider({
    id: "w1",
    category: "weather",
    region: "global",
    search: async (q) => {
      calls.push(q);
      return [
        {
          id: "w1:a",
          sourceProvider: "w1",
          category: "weather",
          title: "Clima en Lima",
          snippet: "20°C",
        },
      ];
    },
  });
  const out = await runUniversalSearch({
    query: "clima en lima hoy",
    deps: { registry: buildFakeRegistry([weather]) },
  });
  assert.deepEqual(out.intents, ["weather"]);
  assert.equal(out.providers.length, 1);
  assert.equal(out.providers[0].providerId, "w1");
  assert.equal(out.providers[0].ok, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, "Clima en Lima");
  assert.equal(calls[0], "clima en lima hoy");
});

test("runUniversalSearch: multi-intent fans out to each category", async () => {
  const jobs = stubProvider({
    id: "j1",
    category: "jobs",
    search: async () => [{ id: "j1:a", sourceProvider: "j1", category: "jobs", title: "Job A" }],
  });
  const shop = stubProvider({
    id: "s1",
    category: "shopping",
    search: async () => [{ id: "s1:a", sourceProvider: "s1", category: "shopping", title: "Laptop" }],
  });
  const out = await runUniversalSearch({
    query: "comprar laptop y trabajo data scientist",
    deps: { registry: buildFakeRegistry([jobs, shop]) },
  });
  assert.ok(out.intents.includes("jobs"));
  assert.ok(out.intents.includes("shopping"));
  const ids = out.providers.map((p) => p.providerId).sort();
  assert.deepEqual(ids, ["j1", "s1"]);
});

test("runUniversalSearch: provider error recorded, others survive", async () => {
  const good = stubProvider({
    id: "good",
    category: "weather",
    search: async () => [{ id: "good:a", sourceProvider: "good", category: "weather", title: "Clima OK" }],
  });
  const bad = stubProvider({
    id: "bad",
    category: "weather",
    search: async () => {
      throw new Error("boom");
    },
  });
  const out = await runUniversalSearch({
    query: "clima ahora",
    deps: { registry: buildFakeRegistry([good, bad]) },
  });
  const badTrace = out.providers.find((p) => p.providerId === "bad");
  const goodTrace = out.providers.find((p) => p.providerId === "good");
  assert.equal(badTrace.ok, false);
  assert.match(badTrace.error, /boom/);
  assert.equal(goodTrace.ok, true);
  assert.equal(out.results.length, 1);
});

test("runUniversalSearch: respects maxResults cap", async () => {
  const p = stubProvider({
    id: "many",
    category: "weather",
    search: async () =>
      Array.from({ length: 30 }, (_, i) => ({
        id: `many:${i}`,
        sourceProvider: "many",
        category: "weather",
        title: `x${i}`,
      })),
  });
  const out = await runUniversalSearch({
    query: "clima",
    maxResults: 5,
    deps: { registry: buildFakeRegistry([p]) },
  });
  assert.equal(out.results.length, 5);
});

test("runUniversalSearch: dedupes by id", () => {
  const { dedupeById } = O_INTERNAL;
  const out = dedupeById([
    { id: "a", title: "first" },
    { id: "a", title: "dup" },
    { id: "b", title: "second" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, "first");
});

test("runUniversalSearch: dedupes by DOI and normalized title", () => {
  const { dedupeById } = O_INTERNAL;
  const out = dedupeById([
    { id: "a", title: "RAG Evaluation", metadata: { doi: "10.1/x" } },
    { id: "b", title: "Other", metadata: { doi: "10.1/x" } },
    { id: "c", title: "RAG: Evaluation!" },
    { id: "d", title: "rag evaluation" },
  ]);
  assert.equal(out.length, 1);
});

test("runUniversalSearch: heuristic rank prioritises primary intent", () => {
  const { heuristicRank } = O_INTERNAL;
  const input = [
    { id: "1", category: "web", title: "A", datePublished: "2020-01-01" },
    { id: "2", category: "weather", title: "B", datePublished: "2020-01-01" },
    { id: "3", category: "weather", title: "C", datePublished: "2024-01-01" },
  ];
  const out = heuristicRank(input, ["weather"]);
  assert.equal(out[0].id, "3");
  assert.equal(out[1].id, "2");
  assert.equal(out[2].id, "1");
});

test("runUniversalSearch: no providers → empty results, no crash", async () => {
  const out = await runUniversalSearch({
    query: "clima",
    deps: { registry: buildFakeRegistry([]) },
  });
  assert.equal(out.results.length, 0);
  assert.equal(out.providers.length, 0);
});

test("runUniversalSearch: timings recorded", async () => {
  const t = { n: 0 };
  const out = await runUniversalSearch({
    query: "clima",
    deps: {
      now: () => (t.n += 5),
      registry: buildFakeRegistry([]),
    },
  });
  assert.ok(typeof out.timings.totalMs === "number");
  assert.ok(out.timings.totalMs >= 0);
});

// ─── Open-Meteo provider shape ───────────────────────────────────────────

test("openMeteoProvider: shape matches SearchProvider contract", () => {
  const { openMeteoProvider } = require("../src/services/searchBrain/universal/providers/weather/openMeteo");
  assert.equal(openMeteoProvider.id, "openmeteo");
  assert.equal(openMeteoProvider.category, "weather");
  assert.ok(REGIONS.includes(openMeteoProvider.region));
  assert.equal(typeof openMeteoProvider.search, "function");
  assert.equal(openMeteoProvider.requiresKey, false);
});

test("index.js: registers Open-Meteo automatically", () => {
  // Re-require to guarantee registration side-effect
  registry.clear();
  delete require.cache[require.resolve("../src/services/searchBrain/universal")];
  const mod = require("../src/services/searchBrain/universal");
  assert.ok(mod.registry.size() >= 100);
  assert.ok(mod.registry.get("openmeteo"));
  assert.ok(mod.registry.get("crossref"));
  assert.ok(mod.registry.get("mercadolibre"));
});

test("catalog: covers every declared category with metadata", () => {
  registry.clear();
  delete require.cache[require.resolve("../src/services/searchBrain/universal")];
  const mod = require("../src/services/searchBrain/universal");
  const metadata = mod.registry.listMetadata();
  for (const category of CATEGORIES) {
    assert.ok(metadata.some((p) => p.category === category), `missing provider for ${category}`);
  }
  assert.ok(metadata.some((p) => p.enabledByDefault === false && p.disabledReason));
});

test("cache: ttl policy covers volatile and stable categories", () => {
  const { ttlFor } = require("../src/services/searchBrain/universal/cache");
  assert.equal(ttlFor(["finance"]), 5 * 60);
  assert.equal(ttlFor(["academic"]), 30 * 24 * 60 * 60);
  assert.equal(ttlFor(["academic", "news"]), 30 * 60);
});
