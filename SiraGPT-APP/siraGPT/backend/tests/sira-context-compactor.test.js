/**
 * sira-context-compactor — verifies the public contract of
 * `compactContext` and the helpers it composes. Closes gap §14.6.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  compactContext,
  dedupMessages,
  rankChunks,
  rankGists,
  contentHash,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_GISTS,
} = require("../src/services/sira/context-compactor");

// ── contentHash ────────────────────────────────────────────────────

describe("contentHash", () => {
  test("equal role+content produce equal hash", () => {
    const a = contentHash({ role: "user", content: "hello" });
    const b = contentHash({ role: "user", content: "hello" });
    assert.equal(a, b);
  });
  test("different role produces different hash", () => {
    assert.notEqual(
      contentHash({ role: "user", content: "x" }),
      contentHash({ role: "system", content: "x" }),
    );
  });
  test("returns null for invalid input", () => {
    assert.equal(contentHash(null), null);
    assert.equal(contentHash({}), null);
    assert.equal(contentHash({ role: "user" }), null);
  });
});

// ── dedupMessages ──────────────────────────────────────────────────

describe("dedupMessages", () => {
  test("drops exact duplicates, keeps first occurrence in order", () => {
    const out = dedupMessages([
      { role: "system", content: "you are X" },
      { role: "user", content: "hi" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].role, "system");
    assert.equal(out[1].content, "hi");
    assert.equal(out[2].content, "hello");
  });

  test("preserves messages with no hashable content (role-only)", () => {
    const out = dedupMessages([{ role: "tool" }, { role: "tool" }]);
    assert.equal(out.length, 2);
  });

  test("returns [] for non-array", () => {
    assert.deepEqual(dedupMessages(null), []);
  });
});

// ── rankChunks ─────────────────────────────────────────────────────

describe("rankChunks", () => {
  test("orders by score descending", () => {
    const out = rankChunks([
      { id: "a", score: 0.3 },
      { id: "b", score: 0.9 },
      { id: "c", score: 0.5 },
    ]);
    assert.deepEqual(out.map((c) => c.id), ["b", "c", "a"]);
  });

  test("missing score sinks to the bottom", () => {
    const out = rankChunks([
      { id: "noscore" },
      { id: "high", score: 0.9 },
      { id: "low", score: 0.1 },
    ]);
    assert.deepEqual(out.map((c) => c.id), ["high", "low", "noscore"]);
  });

  test("respects max cap", () => {
    const out = rankChunks([{ score: 1 }, { score: 2 }, { score: 3 }, { score: 4 }], 2);
    assert.equal(out.length, 2);
  });

  test("default cap is DEFAULT_MAX_CHUNKS", () => {
    const lots = Array.from({ length: 20 }, (_, i) => ({ score: i }));
    assert.equal(rankChunks(lots).length, DEFAULT_MAX_CHUNKS);
  });

  test("does not mutate the input", () => {
    const input = [{ score: 1 }, { score: 2 }];
    const before = JSON.stringify(input);
    rankChunks(input);
    assert.equal(JSON.stringify(input), before);
  });
});

// ── rankGists ──────────────────────────────────────────────────────

describe("rankGists", () => {
  test("respects max cap, default DEFAULT_MAX_GISTS", () => {
    const lots = Array.from({ length: 30 }, (_, i) => ({ id: i }));
    assert.equal(rankGists(lots).length, DEFAULT_MAX_GISTS);
  });
  test("returns [] for non-array", () => {
    assert.deepEqual(rankGists(null), []);
  });
});

// ── compactContext (end-to-end behaviour) ──────────────────────────

describe("compactContext", () => {
  test("returns the same messages when already under budget", async () => {
    const messages = [
      { role: "system", content: "you are X" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const r = await compactContext({ messages, model: "gpt-4o" });
    assert.equal(r.messages.length, 3);
    assert.equal(r.stats.dropped_messages, 0);
    assert.equal(r.stats.summarized, false);
    assert.equal(r.summary, null);
  });

  test("dedups before fitting", async () => {
    const messages = [
      { role: "user", content: "same" },
      { role: "user", content: "same" },
      { role: "user", content: "different" },
    ];
    const r = await compactContext({ messages, model: "gpt-4o" });
    // Two ended up unique because dedup ran first.
    assert.equal(r.stats.original_messages, 3);
    assert.equal(r.stats.deduped_messages, 2);
    assert.equal(r.stats.dedup_collisions, 1);
    assert.equal(r.messages.length, 2);
  });

  test("calls summarizer when messages overflow the window", async () => {
    // Build enough volume to overflow even gpt-4o's 128k window:
    // each message is ~25k chars (~6k tokens). 50 of them → ~300k
    // tokens, well above the 80% safety budget.
    const huge = "x ".repeat(12500);
    const messages = [
      { role: "system", content: "you are X" },
      ...Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: huge + String(i),
      })),
    ];
    let summarizerCalls = 0;
    let droppedSeen = 0;
    const summarizer = async ({ droppedMessages }) => {
      summarizerCalls++;
      droppedSeen = droppedMessages.length;
      return "[summary] earlier turns covered topics A, B, C.";
    };
    const r = await compactContext({ messages, model: "gpt-4o", summarizer });
    assert.equal(summarizerCalls, 1);
    assert.ok(droppedSeen > 0, "summarizer should receive dropped messages");
    assert.match(r.summary, /summary/);
    assert.equal(r.stats.summarized, true);
    assert.ok(r.stats.dropped_messages > 0);
  });

  test("missing summarizer leaves summary null but still returns fitted context", async () => {
    const huge = "x ".repeat(12500);
    const messages = [
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: huge + i })),
    ];
    const r = await compactContext({ messages, model: "gpt-4o" });
    assert.equal(r.summary, null);
    assert.equal(r.stats.summarized, false);
    assert.ok(r.stats.dropped_messages > 0, "should still report drops");
  });

  test("summarizer failure is non-fatal", async () => {
    const huge = "x ".repeat(12500);
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: huge + i }));
    const r = await compactContext({
      messages, model: "gpt-4o",
      summarizer: async () => { throw new Error("model unavailable"); },
    });
    assert.equal(r.summary, null);
    assert.equal(r.stats.summarized, false);
    // Despite the summarizer throwing, the rest of the pipeline still
    // returned a usable context.
    assert.ok(Array.isArray(r.messages) && r.messages.length > 0);
  });

  test("rags + memory gists are ranked and capped", async () => {
    const ragChunks = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, score: i / 20 }));
    const memoryGists = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}` }));
    const r = await compactContext({
      messages: [], model: "gpt-4o",
      ragChunks, memoryGists,
      maxChunks: 5, maxGists: 7,
    });
    assert.equal(r.ragChunks.length, 5);
    assert.equal(r.memoryGists.length, 7);
    // Top scores survive.
    assert.equal(r.ragChunks[0].id, "c19");
    assert.equal(r.stats.chunks_in, 20);
    assert.equal(r.stats.chunks_kept, 5);
    assert.equal(r.stats.gists_in, 30);
    assert.equal(r.stats.gists_kept, 7);
  });

  test("missing inputs degrade gracefully (no crash)", async () => {
    const r = await compactContext({});
    assert.deepEqual(r.messages, []);
    assert.deepEqual(r.ragChunks, []);
    assert.deepEqual(r.memoryGists, []);
    assert.equal(r.summary, null);
    assert.equal(r.stats.original_messages, 0);
  });
});
