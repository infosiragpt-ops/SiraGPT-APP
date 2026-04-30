/**
 * sira-memory-store-adapters — concrete adapters wrapping the
 * existing gist-memory / long-term-memory / project-memory modules
 * to satisfy the unified MemoryStore interface (task 16).
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createShortTermAdapter,
  createSemanticAdapter,
  createProjectAdapter,
  createConversationAdapter,
  createUserAdapter,
} = require("../src/services/sira/memory-store-adapters");
const { createCompositeStore } = require("../src/services/sira/memory-store");

// ── short_term: real gist-memory module ───────────────────────────

describe("createShortTermAdapter (real gist-memory)", () => {
  const gistMemory = require("../src/services/gist-memory");
  const adapter = createShortTermAdapter({ gistMemory });

  test("put + recall (no query) returns the appended triple", async () => {
    gistMemory.clearAll();
    await adapter.put({
      tier: "short_term", scope: { sessionId: "s1" },
      item: { subject: "user", predicate: "wants", object: "summary" },
    });
    const r = await adapter.recall({ tier: "short_term", scope: { sessionId: "s1" } });
    assert.equal(r.length, 1);
    assert.equal(r[0].item.object, "summary");
  });

  test("recall with query ranks matches first", async () => {
    gistMemory.clearAll();
    await adapter.put({ tier: "short_term", scope: { sessionId: "s2" }, item: "abc" });
    await adapter.put({ tier: "short_term", scope: { sessionId: "s2" }, item: "Tailwind preference" });
    const r = await adapter.recall({ tier: "short_term", scope: { sessionId: "s2" }, query: "Tailwind" });
    assert.match(JSON.stringify(r[0].item), /Tailwind/);
    assert.equal(r[0].score, 1);
  });

  test("forget clears the session bucket", async () => {
    gistMemory.clearAll();
    await adapter.put({ tier: "short_term", scope: { sessionId: "s3" }, item: "x" });
    await adapter.forget({ tier: "short_term", scope: { sessionId: "s3" }, id: "ignored" });
    const stats = await adapter.stats({ tier: "short_term", scope: { sessionId: "s3" } });
    assert.equal(stats.count, 0);
  });

  test("scopes are isolated (different sessionId)", async () => {
    gistMemory.clearAll();
    await adapter.put({ tier: "short_term", scope: { sessionId: "a" }, item: "alpha" });
    await adapter.put({ tier: "short_term", scope: { sessionId: "b" }, item: "beta" });
    const a = await adapter.recall({ tier: "short_term", scope: { sessionId: "a" } });
    const b = await adapter.recall({ tier: "short_term", scope: { sessionId: "b" } });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  });

  test("missing module raises memory.adapter_misconfigured", () => {
    assert.throws(
      () => createShortTermAdapter({}),
      { code: "memory.adapter_misconfigured" },
    );
  });
});

// ── semantic: faked long-term-memory module ───────────────────────

describe("createSemanticAdapter (faked long-term-memory)", () => {
  function fakeLongTermMemory({ recallReturns = [], statsReturns = { count: 0 } } = {}) {
    const calls = [];
    return {
      _calls: calls,
      async recallFacts(args) { calls.push(["recallFacts", args]); return recallReturns; },
      async clearUserMemory(userId) { calls.push(["clearUserMemory", userId]); },
      async memoryStats(userId) { calls.push(["memoryStats", userId]); return statsReturns; },
    };
  }

  test("put returns sentinel id (long-term extraction is async)", async () => {
    const adapter = createSemanticAdapter({ longTermMemory: fakeLongTermMemory() });
    const r = await adapter.put({ tier: "semantic", scope: { userId: "u1" }, item: "fact" });
    assert.equal(r.id, "semantic:async-extraction");
  });

  test("recall translates recallFacts results into the unified shape", async () => {
    const ltm = fakeLongTermMemory({
      recallReturns: [
        { fact: "Luis prefers Tailwind", score: 0.92, importance: 0.7, id: "f1", created_at: "2026-04-29T00:00:00Z" },
        { fact: "Backend uses node:test", score: 0.71, importance: 0.5, id: "f2" },
      ],
    });
    const adapter = createSemanticAdapter({ longTermMemory: ltm });
    const r = await adapter.recall({ tier: "semantic", scope: { userId: "u1" }, query: "Tailwind", limit: 5 });
    assert.equal(r.length, 2);
    assert.equal(r[0].score, 0.92);
    assert.equal(r[0].id, "f1");
    assert.equal(r[1].score, 0.71);
    assert.equal(ltm._calls[0][0], "recallFacts");
  });

  test("forget calls clearUserMemory on the user", async () => {
    const ltm = fakeLongTermMemory();
    const adapter = createSemanticAdapter({ longTermMemory: ltm });
    const r = await adapter.forget({ tier: "semantic", scope: { userId: "u1" }, id: "ignored" });
    assert.equal(r.ok, true);
    assert.deepEqual(ltm._calls.find((c) => c[0] === "clearUserMemory"), ["clearUserMemory", "u1"]);
  });

  test("stats reports count from memoryStats", async () => {
    const ltm = fakeLongTermMemory({ statsReturns: { count: 17 } });
    const adapter = createSemanticAdapter({ longTermMemory: ltm });
    const r = await adapter.stats({ tier: "semantic", scope: { userId: "u1" } });
    assert.equal(r.count, 17);
  });
});

// ── project: faked project-memory module ──────────────────────────

describe("createProjectAdapter (faked project-memory + prisma)", () => {
  function fakeProjectMemory({ list = [], saveFactsReturn = [{ id: "pf1" }], deleteOk = true } = {}) {
    const calls = [];
    return {
      _calls: calls,
      async saveFacts(prisma, projectId, facts) {
        calls.push(["saveFacts", projectId, facts]);
        return saveFactsReturn;
      },
      async listMemory(prisma, { projectId }) {
        calls.push(["listMemory", projectId]);
        return list;
      },
      async deleteMemory(prisma, { projectId, factId }) {
        calls.push(["deleteMemory", projectId, factId]);
        return { ok: deleteOk };
      },
    };
  }

  test("put writes a fact and returns the prefixed id", async () => {
    const projectMemory = fakeProjectMemory();
    const adapter = createProjectAdapter({ projectMemory, prisma: {} });
    const r = await adapter.put({
      tier: "project", scope: { projectId: "p1" },
      item: "Decision: deploy via Vercel",
    });
    assert.equal(r.id, "project:pf1");
  });

  test("recall filters by query substring", async () => {
    const projectMemory = fakeProjectMemory({
      list: [
        { id: "a", text: "deploy via Vercel" },
        { id: "b", text: "use Tailwind for styling" },
      ],
    });
    const adapter = createProjectAdapter({ projectMemory, prisma: {} });
    const r = await adapter.recall({ tier: "project", scope: { projectId: "p1" }, query: "Tailwind" });
    assert.equal(r[0].score, 1);
    assert.match(JSON.stringify(r[0].item), /Tailwind/);
  });

  test("forget delegates and returns { ok: false } on miss", async () => {
    const projectMemory = fakeProjectMemory({ deleteOk: false });
    const adapter = createProjectAdapter({ projectMemory, prisma: {} });
    const r = await adapter.forget({ tier: "project", scope: { projectId: "p1" }, id: "project:missing" });
    assert.equal(r.ok, false);
  });

  test("stats counts list rows and reports timestamps", async () => {
    const projectMemory = fakeProjectMemory({
      list: [
        { id: "a", text: "x", createdAt: "2026-04-01T00:00:00Z" },
        { id: "b", text: "y", createdAt: "2026-04-15T00:00:00Z" },
      ],
    });
    const adapter = createProjectAdapter({ projectMemory, prisma: {} });
    const s = await adapter.stats({ tier: "project", scope: { projectId: "p1" } });
    assert.equal(s.count, 2);
    assert.ok(s.oldest_ts < s.newest_ts);
  });
});

// ── In-process tiers (conversation / user) ─────────────────────────

describe("conversation + user adapters (in-process)", () => {
  test("conversation adapter: put + recall + forget + stats", async () => {
    const a = createConversationAdapter();
    await a.put({ tier: "conversation", scope: { conversationId: "c1" }, item: "first" });
    const { id } = await a.put({ tier: "conversation", scope: { conversationId: "c1" }, item: "second" });
    const r = await a.recall({ tier: "conversation", scope: { conversationId: "c1" } });
    assert.equal(r.length, 2);
    await a.forget({ tier: "conversation", scope: { conversationId: "c1" }, id });
    const s = await a.stats({ tier: "conversation", scope: { conversationId: "c1" } });
    assert.equal(s.count, 1);
  });

  test("user adapter: scoped per userId", async () => {
    const a = createUserAdapter();
    await a.put({ tier: "user", scope: { userId: "u1" }, item: "alpha" });
    await a.put({ tier: "user", scope: { userId: "u2" }, item: "beta" });
    const r1 = await a.recall({ tier: "user", scope: { userId: "u1" } });
    const r2 = await a.recall({ tier: "user", scope: { userId: "u2" } });
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 1);
  });
});

// ── End-to-end via the composite store ─────────────────────────────

describe("composite store with all five real adapters", () => {
  test("routes each tier to its adapter and the calls round-trip", async () => {
    const gistMemory = require("../src/services/gist-memory");
    gistMemory.clearAll();
    const ltmFake = {
      async recallFacts() { return [{ fact: "from ltm", score: 0.5, id: "ltm-1" }]; },
      async clearUserMemory() {},
      async memoryStats() { return { count: 0 }; },
    };
    const projectFake = {
      async saveFacts() { return [{ id: "pf-x" }]; },
      async listMemory() { return [{ id: "pf-x", text: "from project", createdAt: new Date().toISOString() }]; },
      async deleteMemory() { return { ok: true }; },
    };

    const composite = createCompositeStore({
      short_term: createShortTermAdapter({ gistMemory }),
      semantic: createSemanticAdapter({ longTermMemory: ltmFake }),
      project: createProjectAdapter({ projectMemory: projectFake, prisma: {} }),
      conversation: createConversationAdapter(),
      user: createUserAdapter(),
    });

    await composite.put({ tier: "short_term", scope: { sessionId: "s1" }, item: "from gist" });
    const semantic = await composite.recall({ tier: "semantic", scope: { userId: "u1" }, query: "from" });
    const project = await composite.recall({ tier: "project", scope: { projectId: "p1" } });
    const shortTerm = await composite.recall({ tier: "short_term", scope: { sessionId: "s1" } });

    assert.equal(semantic[0].score, 0.5);
    assert.match(JSON.stringify(project[0].item), /from project/);
    assert.equal(shortTerm.length, 1);
  });
});
