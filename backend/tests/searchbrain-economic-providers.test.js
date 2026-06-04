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

test("no duplicate provider ids exist in the catalog", () => {
  const ids = catalogProviders.map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepStrictEqual([...new Set(dupes)], [], `duplicate provider ids: ${[...new Set(dupes)].join(", ")}`);
});
