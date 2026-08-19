/**
 * sira-semantic-tool-cache — verifies canonicalization, hashing,
 * LRU eviction, TTL expiry, error caching, and singleflight
 * coalescing.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  SemanticToolCache,
  hashKey,
  canonicalize,
  DEFAULT_MAX,
} = require("../src/services/sira/semantic-tool-cache");

// ── canonicalize ───────────────────────────────────────────────────

describe("canonicalize", () => {
  test("primitives pass through", () => {
    assert.equal(canonicalize("a"), "a");
    assert.equal(canonicalize(1), 1);
    assert.equal(canonicalize(true), true);
    assert.equal(canonicalize(null), null);
  });
  test("undefined / function / symbol → undefined", () => {
    assert.equal(canonicalize(undefined), undefined);
    assert.equal(canonicalize(() => {}), undefined);
    assert.equal(canonicalize(Symbol("s")), undefined);
  });
  test("NaN / Infinity → null", () => {
    assert.equal(canonicalize(NaN), null);
    assert.equal(canonicalize(Infinity), null);
  });
  test("Date → date:ISO string", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(canonicalize(d), `date:${d.toISOString()}`);
  });
  test("object keys are sorted recursively", () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    assert.deepEqual(Object.keys(a), ["a", "b"]);
    assert.deepEqual(Object.keys(a.a), ["x", "y"]);
  });
  test("removes undefined values", () => {
    const c = canonicalize({ a: 1, b: undefined, c: 3 });
    assert.deepEqual(c, { a: 1, c: 3 });
  });
  test("handles cyclic structures without throwing", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const c = canonicalize(cyclic);
    assert.equal(c.self, "[cycle]");
  });
  test("Buffer → buffer:<sha256-prefix>", () => {
    const b = canonicalize(Buffer.from("hello"));
    assert.match(b, /^buffer:[a-f0-9]{32}$/);
  });
  test("BigInt → bigint:<digits>", () => {
    assert.equal(canonicalize(BigInt(42)), "bigint:42");
  });
});

// ── hashKey ────────────────────────────────────────────────────────

describe("hashKey", () => {
  test("same args → same hash", () => {
    assert.equal(
      hashKey("web_search", { q: "openai", n: 5 }),
      hashKey("web_search", { n: 5, q: "openai" }),
    );
  });
  test("different tool name → different hash", () => {
    assert.notEqual(
      hashKey("web_search", { q: "x" }),
      hashKey("rag_retrieve", { q: "x" }),
    );
  });
  test("different args → different hash", () => {
    assert.notEqual(
      hashKey("t", { q: "a" }),
      hashKey("t", { q: "b" }),
    );
  });
  test("rejects empty toolName", () => {
    assert.throws(() => hashKey("", {}), TypeError);
  });
  test("undefined args is safe", () => {
    assert.match(hashKey("t", undefined), /^t:[a-f0-9]{32}$/);
  });
});

// ── LRU + TTL ──────────────────────────────────────────────────────

describe("SemanticToolCache — LRU / TTL", () => {
  test("set/get round-trip", () => {
    const c = new SemanticToolCache();
    c.set("t", { q: 1 }, "VALUE");
    const e = c.get("t", { q: 1 });
    assert.ok(e);
    assert.equal(e.value, "VALUE");
  });
  test("miss returns undefined", () => {
    const c = new SemanticToolCache();
    assert.equal(c.get("t", { q: 1 }), undefined);
  });
  test("eviction respects max", () => {
    const c = new SemanticToolCache({ max: 2 });
    c.set("t", { q: 1 }, "A");
    c.set("t", { q: 2 }, "B");
    c.set("t", { q: 3 }, "C");
    assert.equal(c.size(), 2);
    // First inserted (q=1) should be evicted.
    assert.equal(c.get("t", { q: 1 }), undefined);
    assert.ok(c.get("t", { q: 2 }));
    assert.ok(c.get("t", { q: 3 }));
  });
  test("LRU touch on get prevents eviction", () => {
    const c = new SemanticToolCache({ max: 2 });
    c.set("t", { q: 1 }, "A");
    c.set("t", { q: 2 }, "B");
    // Touch q=1 so q=2 is least recent.
    c.get("t", { q: 1 });
    c.set("t", { q: 3 }, "C");
    assert.ok(c.get("t", { q: 1 }));
    assert.equal(c.get("t", { q: 2 }), undefined);
  });
  test("ttl expiry", () => {
    let now = 1_000;
    const c = new SemanticToolCache({ ttlMs: 100, now: () => now });
    c.set("t", { x: 1 }, "V");
    assert.ok(c.get("t", { x: 1 }));
    now += 200;
    assert.equal(c.get("t", { x: 1 }), undefined);
  });
  test("prune drops expired entries", () => {
    let now = 0;
    const c = new SemanticToolCache({ ttlMs: 50, now: () => now });
    c.set("t", { a: 1 }, "A");
    c.set("t", { a: 2 }, "B");
    now = 100;
    assert.equal(c.prune(), 2);
    assert.equal(c.size(), 0);
  });
  test("delete removes entry", () => {
    const c = new SemanticToolCache();
    c.set("t", { x: 1 }, "V");
    assert.equal(c.delete("t", { x: 1 }), true);
    assert.equal(c.get("t", { x: 1 }), undefined);
  });
  test("clear empties the store", () => {
    const c = new SemanticToolCache();
    c.set("t", { x: 1 }, "V");
    c.clear();
    assert.equal(c.size(), 0);
  });
  test("default max is exposed", () => {
    assert.equal(typeof DEFAULT_MAX, "number");
  });
});

// ── wrap ───────────────────────────────────────────────────────────

describe("SemanticToolCache.wrap", () => {
  test("first call executes, second hits cache", async () => {
    let calls = 0;
    const c = new SemanticToolCache();
    const exec = async () => { calls += 1; return "RESULT"; };
    const a = await c.wrap("t", { x: 1 }, exec);
    const b = await c.wrap("t", { x: 1 }, exec);
    assert.equal(a, "RESULT");
    assert.equal(b, "RESULT");
    assert.equal(calls, 1);
  });
  test("singleflight coalesces concurrent calls", async () => {
    let calls = 0;
    const c = new SemanticToolCache();
    const exec = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return "X";
    };
    const all = await Promise.all([
      c.wrap("t", { q: 1 }, exec),
      c.wrap("t", { q: 1 }, exec),
      c.wrap("t", { q: 1 }, exec),
    ]);
    assert.deepEqual(all, ["X", "X", "X"]);
    assert.equal(calls, 1);
    assert.equal(c.getStats().coalesced, 2);
  });
  test("rethrows + does not cache by default", async () => {
    let calls = 0;
    const c = new SemanticToolCache();
    const exec = async () => { calls += 1; throw new Error("fail"); };
    await assert.rejects(() => c.wrap("t", {}, exec), /fail/);
    await assert.rejects(() => c.wrap("t", {}, exec), /fail/);
    assert.equal(calls, 2);
  });
  test("cacheErrors=true caches negative results", async () => {
    let calls = 0;
    const c = new SemanticToolCache({ cacheErrors: true, errorTtlMs: 1000 });
    const exec = async () => { calls += 1; throw new Error("nope"); };
    await assert.rejects(() => c.wrap("t", {}, exec), /nope/);
    await assert.rejects(() => c.wrap("t", {}, exec), /nope/);
    assert.equal(calls, 1);
    assert.equal(c.getStats().errorsCached, 1);
  });
  test("rejects non-function executor", async () => {
    const c = new SemanticToolCache();
    await assert.rejects(() => c.wrap("t", {}, null), TypeError);
  });
});

describe("getStats", () => {
  test("counts hits/misses/sets", () => {
    const c = new SemanticToolCache();
    c.get("t", { x: 1 }); // miss
    c.set("t", { x: 1 }, "V");
    c.get("t", { x: 1 }); // hit
    c.get("t", { x: 1 }); // hit
    const s = c.getStats();
    assert.equal(s.misses, 1);
    assert.equal(s.hits, 2);
    assert.equal(s.sets, 1);
    assert.equal(s.size, 1);
  });
});
