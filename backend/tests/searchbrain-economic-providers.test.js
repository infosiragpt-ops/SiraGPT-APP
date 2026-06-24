const test = require("node:test");
const assert = require("node:assert");

const { catalogProviders } = require("../src/services/searchBrain/universal/providers/catalog");
const { guardedSearch } = require("../src/services/searchBrain/universal/providers/providerUtils");

function byId(id) {
  return catalogProviders.filter((p) => p.id === id);
}

test("fred provider is registered exactly once and is key-gated", () => {
  const fred = byId("fred");
  assert.strictEqual(fred.length, 1, "fred must be registered exactly once (no duplicate disabled stub)");
  assert.strictEqual(fred[0].category, "finance");
  assert.strictEqual(fred[0].requiresKey, true);
  assert.strictEqual(typeof fred[0].search, "function");
});

test("fred returns [] gracefully when no key is configured", async () => {
  const prev = process.env.SEARCH_BRAIN_FRED_KEY;
  delete process.env.SEARCH_BRAIN_FRED_KEY;
  try {
    const fred = byId("fred")[0];
    const out = await fred.search("gdp", {});
    assert.deepStrictEqual(out, []);
  } finally {
    if (prev !== undefined) process.env.SEARCH_BRAIN_FRED_KEY = prev;
  }
});

test("worldbank-indicators provider is registered and key-free", () => {
  const wb = byId("worldbank-indicators");
  assert.strictEqual(wb.length, 1);
  assert.strictEqual(wb[0].category, "finance");
  assert.strictEqual(wb[0].requiresKey, false);
  assert.strictEqual(typeof wb[0].search, "function");
});

test("existing country-level worldbank provider is preserved and distinct", () => {
  assert.strictEqual(byId("worldbank").length, 1);
  assert.notStrictEqual(byId("worldbank")[0], byId("worldbank-indicators")[0]);
});

test("guardedSearch runs the current query closure (no stale-closure caching across queries)", async () => {
  const id = "test-breaker-regression";
  const first = await guardedSearch(id, async () => [{ q: "first" }]);
  const second = await guardedSearch(id, async () => [{ q: "second" }]);
  assert.deepStrictEqual(first, [{ q: "first" }]);
  assert.deepStrictEqual(second, [{ q: "second" }]);
});

test("brave-search provider is registered exactly once and is key-gated", () => {
  const brave = byId("brave-search");
  assert.strictEqual(brave.length, 1, "brave-search must be registered exactly once (no leftover disabled stub)");
  assert.strictEqual(brave[0].category, "web");
  assert.strictEqual(brave[0].requiresKey, true);
  assert.strictEqual(typeof brave[0].search, "function");
});

test("brave-search returns [] gracefully when no key is configured", async () => {
  const prevPrimary = process.env.BRAVE_SEARCH_API_KEY;
  const prevAlias = process.env.BRAVE_API_KEY;
  const prevBrain = process.env.SEARCH_BRAIN_BRAVE_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.SEARCH_BRAIN_BRAVE_KEY;
  try {
    const brave = byId("brave-search")[0];
    assert.deepStrictEqual(await brave.search("ai news", {}), []);
    // empty/invalid query also short-circuits
    assert.deepStrictEqual(await brave.search("", { keys: { brave: "k" } }), []);
  } finally {
    if (prevPrimary !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevPrimary;
    if (prevAlias !== undefined) process.env.BRAVE_API_KEY = prevAlias;
    if (prevBrain !== undefined) process.env.SEARCH_BRAIN_BRAVE_KEY = prevBrain;
  }
});

test("no duplicate provider ids exist in the catalog", () => {
  const ids = catalogProviders.map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], `duplicate provider ids: ${[...new Set(dupes)].join(", ")}`);
});
