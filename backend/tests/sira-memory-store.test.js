/**
 * sira-memory-store — unified four-tier memory contract.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TIERS,
  REQUIRED_SCOPE,
  MemoryError,
  validateTier,
  validateScope,
  createInMemoryStore,
  createCompositeStore,
} = require("../src/services/sira/memory-store");

// ── Tier + scope validation ────────────────────────────────────────

describe("validation", () => {
  test("TIERS lists the five canonical tiers", () => {
    assert.deepEqual(TIERS, ["short_term", "conversation", "semantic", "project", "user"]);
  });

  test("validateTier rejects unknown tiers", () => {
    assert.throws(() => validateTier("nope"), { code: "memory.invalid_tier" });
  });

  test("validateScope enforces the required scope keys per tier", () => {
    for (const tier of TIERS) {
      assert.throws(() => validateScope(tier, {}), { code: "memory.invalid_scope" });
    }
  });

  test("REQUIRED_SCOPE matches the documented contract", () => {
    assert.deepEqual(REQUIRED_SCOPE.short_term, ["sessionId"]);
    assert.deepEqual(REQUIRED_SCOPE.conversation, ["conversationId"]);
    assert.deepEqual(REQUIRED_SCOPE.semantic, ["userId"]);
    assert.deepEqual(REQUIRED_SCOPE.project, ["projectId"]);
    assert.deepEqual(REQUIRED_SCOPE.user, ["userId"]);
  });
});

// ── In-memory store ────────────────────────────────────────────────

describe("createInMemoryStore", () => {
  test("put returns an id and stores the item", async () => {
    const store = createInMemoryStore();
    const r = await store.put({
      tier: "short_term",
      scope: { sessionId: "s1" },
      item: { text: "hello world", role: "user" },
    });
    assert.match(r.id, /^mem_/);
  });

  test("recall returns items by recency when no query", async () => {
    const store = createInMemoryStore({ now: ((t) => () => ++t)(0) });
    await store.put({ tier: "short_term", scope: { sessionId: "s1" }, item: "first" });
    await store.put({ tier: "short_term", scope: { sessionId: "s1" }, item: "second" });
    await store.put({ tier: "short_term", scope: { sessionId: "s1" }, item: "third" });
    const r = await store.recall({ tier: "short_term", scope: { sessionId: "s1" } });
    assert.equal(r[0].item, "third");
    assert.equal(r[2].item, "first");
  });

  test("recall ranks by query overlap when query supplied", async () => {
    const store = createInMemoryStore();
    await store.put({ tier: "semantic", scope: { userId: "u1" }, item: { text: "Luis prefers Tailwind for styling." } });
    await store.put({ tier: "semantic", scope: { userId: "u1" }, item: { text: "We deploy via Vercel for the frontend." } });
    await store.put({ tier: "semantic", scope: { userId: "u1" }, item: { text: "Backend tests run with node:test." } });
    const r = await store.recall({ tier: "semantic", scope: { userId: "u1" }, query: "Tailwind" });
    assert.equal(r[0].score, 1);
    assert.match(JSON.stringify(r[0].item), /Tailwind/);
  });

  test("recall respects limit", async () => {
    const store = createInMemoryStore();
    for (let i = 0; i < 8; i++) {
      await store.put({ tier: "user", scope: { userId: "u1" }, item: `item${i}` });
    }
    const r = await store.recall({ tier: "user", scope: { userId: "u1" }, limit: 3 });
    assert.equal(r.length, 3);
  });

  test("scopes are isolated — same tier different scope is invisible", async () => {
    const store = createInMemoryStore();
    await store.put({ tier: "conversation", scope: { conversationId: "c1" }, item: "alpha" });
    await store.put({ tier: "conversation", scope: { conversationId: "c2" }, item: "beta" });
    const r = await store.recall({ tier: "conversation", scope: { conversationId: "c1" } });
    assert.equal(r.length, 1);
    assert.equal(r[0].item, "alpha");
  });

  test("forget removes by id and reports ok=false on miss", async () => {
    const store = createInMemoryStore();
    const { id } = await store.put({ tier: "short_term", scope: { sessionId: "s" }, item: "x" });
    const r1 = await store.forget({ tier: "short_term", scope: { sessionId: "s" }, id });
    assert.equal(r1.ok, true);
    const r2 = await store.forget({ tier: "short_term", scope: { sessionId: "s" }, id: "nope" });
    assert.equal(r2.ok, false);
  });

  test("stats reports count + oldest/newest timestamps", async () => {
    const store = createInMemoryStore({ now: ((t) => () => ++t)(99) });
    await store.put({ tier: "project", scope: { projectId: "p1" }, item: "x" });
    await store.put({ tier: "project", scope: { projectId: "p1" }, item: "y" });
    const s = await store.stats({ tier: "project", scope: { projectId: "p1" } });
    assert.equal(s.count, 2);
    assert.ok(s.oldest_ts < s.newest_ts);
  });

  test("stats on empty bucket returns count=0 and null timestamps", async () => {
    const store = createInMemoryStore();
    const s = await store.stats({ tier: "user", scope: { userId: "ghost" } });
    assert.equal(s.count, 0);
    assert.equal(s.oldest_ts, null);
    assert.equal(s.newest_ts, null);
  });

  test("put requires a non-null item", async () => {
    const store = createInMemoryStore();
    await assert.rejects(
      () => store.put({ tier: "user", scope: { userId: "u1" }, item: null }),
      { code: "memory.missing_item" },
    );
  });

  test("forget requires an id", async () => {
    const store = createInMemoryStore();
    await assert.rejects(
      () => store.forget({ tier: "user", scope: { userId: "u1" }, id: null }),
      { code: "memory.missing_id" },
    );
  });
});

// ── Composite ──────────────────────────────────────────────────────

describe("createCompositeStore", () => {
  function fakeAdapter(label) {
    const calls = [];
    return {
      _calls: calls,
      async put(args) { calls.push(["put", args]); return { id: `${label}-id` }; },
      async recall(args) { calls.push(["recall", args]); return [{ item: `${label}-item`, score: 1 }]; },
      async forget(args) { calls.push(["forget", args]); return { ok: true }; },
      async stats(args) { calls.push(["stats", args]); return { count: 0, tier: args.tier, scope: args.scope }; },
    };
  }

  test("routes each tier to its own adapter", async () => {
    const semantic = fakeAdapter("semantic");
    const short = fakeAdapter("short_term");
    const composite = createCompositeStore({ semantic, short_term: short });
    await composite.put({ tier: "semantic", scope: { userId: "u" }, item: "x" });
    await composite.recall({ tier: "short_term", scope: { sessionId: "s" } });
    assert.equal(semantic._calls.length, 1);
    assert.equal(short._calls.length, 1);
    assert.equal(semantic._calls[0][0], "put");
    assert.equal(short._calls[0][0], "recall");
  });

  test("raises memory.tier_unwired when adapter is missing", async () => {
    const composite = createCompositeStore({ semantic: fakeAdapter("semantic") });
    await assert.rejects(
      () => composite.put({ tier: "project", scope: { projectId: "p" }, item: "x" }),
      { code: "memory.tier_unwired" },
    );
  });

  test("validates tier + scope before routing", async () => {
    const composite = createCompositeStore({ semantic: fakeAdapter("semantic") });
    await assert.rejects(
      () => composite.put({ tier: "nope", scope: {}, item: "x" }),
      { code: "memory.invalid_tier" },
    );
    await assert.rejects(
      () => composite.put({ tier: "semantic", scope: {}, item: "x" }),
      { code: "memory.invalid_scope" },
    );
  });
});
