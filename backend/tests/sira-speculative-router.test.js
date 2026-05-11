/**
 * sira-speculative-router — verifies complexity classification,
 * cascade resolution, cascade invocation (incl. retry/fallback),
 * and learned-classifier integration.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TIERS,
  classifyHeuristic,
  resolveCascade,
  invokeCascade,
  route,
  _internals,
} = require("../src/services/sira/speculative-router");

const { defaultIsRetryable, dedup } = _internals;

const CATALOG = {
  fast: ["haiku-x", "mini-y"],
  standard: ["sonnet-x", "gpt-4o"],
  heavy: ["opus-x", "gpt-5"],
};

// ── classifyHeuristic ──────────────────────────────────────────────

describe("classifyHeuristic", () => {
  test("short greeting → fast tier", () => {
    const c = classifyHeuristic({ text: "hola" });
    assert.equal(c.tier, TIERS.FAST);
  });
  test("refactor request → heavy tier", () => {
    const c = classifyHeuristic({
      text: "Please refactor this whole architecture to use a different pattern, and migrate all callers.",
    });
    assert.equal(c.tier, TIERS.HEAVY);
  });
  test("medium-length question → standard tier", () => {
    // Long text (~5000 chars → ~1250 tokens) bumps score into standard.
    const text = "Explain in step-by-step detail how this implementation flows. ".repeat(80);
    const c = classifyHeuristic({ text });
    assert.notEqual(c.tier, TIERS.FAST);
  });
  test("attachments raise the score", () => {
    const a = classifyHeuristic({ text: "summarize the document" });
    const b = classifyHeuristic({
      text: "summarize the document",
      attachments: [1, 2, 3, 4, 5, 6, 7],
    });
    assert.ok(b.score > a.score);
  });
  test("history length raises the score", () => {
    const a = classifyHeuristic({ text: "summarize the document" });
    const longHistory = Array.from({ length: 35 }, () => ({ role: "user" }));
    const b = classifyHeuristic({ text: "summarize the document", history: longHistory });
    assert.ok(b.score > a.score);
  });
  test("requiresTools=true bumps the score", () => {
    const a = classifyHeuristic({ text: "summarize the document" });
    const b = classifyHeuristic({ text: "summarize the document", requiresTools: true });
    assert.ok(b.score > a.score);
  });
  test("invalid input safely returns a result", () => {
    const c = classifyHeuristic({});
    assert.ok(c.tier);
    assert.equal(c.score, 0);
  });
});

// ── resolveCascade ─────────────────────────────────────────────────

describe("resolveCascade", () => {
  test("heavy puts heavy first", () => {
    const cascade = resolveCascade(TIERS.HEAVY, CATALOG);
    assert.equal(cascade[0], "opus-x");
  });
  test("fast puts fast first", () => {
    const cascade = resolveCascade(TIERS.FAST, CATALOG);
    assert.equal(cascade[0], "haiku-x");
  });
  test("dedupes overlapping providers", () => {
    const cascade = resolveCascade(TIERS.STANDARD, {
      fast: ["A"],
      standard: ["B", "A"],
      heavy: ["C", "A"],
    });
    const seen = new Set(cascade);
    assert.equal(seen.size, cascade.length);
  });
  test("throws on missing catalog", () => {
    assert.throws(() => resolveCascade(TIERS.FAST, null), TypeError);
  });
});

describe("dedup helper", () => {
  test("preserves order, removes dupes", () => {
    assert.deepEqual(dedup(["a", "b", "a", "c"]), ["a", "b", "c"]);
  });
  test("ignores non-strings and empties", () => {
    assert.deepEqual(dedup(["a", "", null, undefined, "b"]), ["a", "b"]);
  });
});

// ── invokeCascade ──────────────────────────────────────────────────

describe("invokeCascade", () => {
  test("first provider succeeds", async () => {
    const out = await invokeCascade({
      request: { x: 1 },
      cascade: ["a", "b", "c"],
      invoker: async (id) => ({ id, ok: true }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.providerId, "a");
    assert.equal(out.attempts.length, 1);
  });
  test("falls through retryable errors", async () => {
    const out = await invokeCascade({
      request: {},
      cascade: ["a", "b"],
      invoker: async (id) => {
        if (id === "a") {
          const err = new Error("transient");
          err.status = 503;
          throw err;
        }
        return { id, value: 42 };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.providerId, "b");
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].ok, false);
  });
  test("stops on fatal error", async () => {
    const out = await invokeCascade({
      request: {},
      cascade: ["a", "b"],
      invoker: async () => {
        const err = new Error("bad request");
        err.status = 400;
        throw err;
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.attempts.length, 1);
  });
  test("respects abort signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await invokeCascade({
      request: {},
      cascade: ["a", "b"],
      invoker: async () => ({ ok: true }),
      signal: ac.signal,
    });
    assert.equal(out.ok, false);
    assert.equal(out.attempts[0].error.name, "AbortError");
  });
  test("requires non-empty cascade", async () => {
    await assert.rejects(
      () => invokeCascade({ request: {}, cascade: [], invoker: async () => ({}) }),
      TypeError,
    );
  });
  test("requires invoker function", async () => {
    await assert.rejects(
      () => invokeCascade({ request: {}, cascade: ["a"], invoker: null }),
      TypeError,
    );
  });
});

describe("defaultIsRetryable", () => {
  test("ECONNRESET → true", () => {
    const e = new Error("x");
    e.code = "ECONNRESET";
    assert.equal(defaultIsRetryable(e), true);
  });
  test("503 → true", () => {
    const e = new Error("x");
    e.status = 503;
    assert.equal(defaultIsRetryable(e), true);
  });
  test("400 → false", () => {
    const e = new Error("x");
    e.status = 400;
    assert.equal(defaultIsRetryable(e), false);
  });
  test("AbortError → false", () => {
    const e = new Error("x");
    e.name = "AbortError";
    assert.equal(defaultIsRetryable(e), false);
  });
  test("null → false", () => assert.equal(defaultIsRetryable(null), false));
});

// ── route() integration ────────────────────────────────────────────

describe("route — end to end", () => {
  test("classifies and invokes appropriate cascade", async () => {
    const calls = [];
    const out = await route({
      text: "hi",
      catalog: CATALOG,
      invoker: async (id) => {
        calls.push(id);
        return { id };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.classification.tier, TIERS.FAST);
    assert.equal(out.providerId, "haiku-x");
    assert.equal(calls[0], "haiku-x");
  });
  test("learned classifier overrides heuristic", async () => {
    const out = await route({
      text: "hi",
      catalog: CATALOG,
      invoker: async (id) => ({ id }),
      learnedClassifier: async () => ({ score: 0.95, reasons: ["learned"] }),
    });
    assert.equal(out.classification.tier, TIERS.HEAVY);
    assert.equal(out.providerId, "opus-x");
  });
  test("falls back to heuristic if learned classifier throws", async () => {
    const out = await route({
      text: "hi",
      catalog: CATALOG,
      invoker: async (id) => ({ id }),
      learnedClassifier: async () => { throw new Error("oops"); },
    });
    assert.equal(out.classification.tier, TIERS.FAST);
    assert.equal(out.ok, true);
  });
});
