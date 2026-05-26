/**
 * sira-context-compactor — model-aware clamp of the summarizer's
 * output budget. Mirrors the openclaw v2026.5.7 fix: high-context
 * compaction must never request `max_tokens` larger than what the
 * target model can emit in a single response.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  compactContext,
  clampSummaryReserve,
  DEFAULT_SUMMARY_OUTPUT_SHARE,
  MIN_SUMMARY_OUTPUT_TOKENS,
} = require("../src/services/sira/context-compactor");
const { getCompletionLimit } = require("../src/services/context-window");

describe("clampSummaryReserve", () => {
  test("never exceeds the model's completion ceiling", () => {
    const ceiling = getCompletionLimit("gpt-4o"); // 16384
    const got = clampSummaryReserve(ceiling * 100, "gpt-4o");
    assert.ok(got <= ceiling, `expected ${got} <= ${ceiling}`);
  });

  test("respects the configurable share of the completion ceiling", () => {
    const ceiling = getCompletionLimit("claude-opus-4-7"); // 32000
    const got = clampSummaryReserve(ceiling, "claude-opus-4-7", 0.1);
    assert.ok(got <= Math.floor(ceiling * 0.1));
    assert.ok(got >= MIN_SUMMARY_OUTPUT_TOKENS);
  });

  test("default share is 25%", () => {
    const ceiling = getCompletionLimit("claude-sonnet-4-6"); // 64000
    const got = clampSummaryReserve(ceiling, "claude-sonnet-4-6");
    assert.equal(got, Math.floor(ceiling * DEFAULT_SUMMARY_OUTPUT_SHARE));
  });

  test("never drops below MIN_SUMMARY_OUTPUT_TOKENS for normal models", () => {
    const got = clampSummaryReserve(10, "gpt-4o");
    assert.ok(got >= MIN_SUMMARY_OUTPUT_TOKENS);
  });

  test("falls back to default reserve on bad input", () => {
    const got = clampSummaryReserve(NaN, "gpt-4o");
    assert.ok(Number.isFinite(got) && got > 0);
  });

  test("clamps to share when caller asks for huge reserve on huge-output model", () => {
    // deepseek-v4-pro has max_output 384000 — share cap dominates.
    const got = clampSummaryReserve(1_000_000, "deepseek-v4-pro");
    const ceiling = getCompletionLimit("deepseek-v4-pro");
    assert.ok(got <= Math.floor(ceiling * DEFAULT_SUMMARY_OUTPUT_SHARE));
  });
});

describe("compactContext — clamp wiring", () => {
  test("passes a clamped maxOutputTokens into the summarizer", async () => {
    const seen = {};
    const summarizer = async ({ droppedMessages, model, maxOutputTokens }) => {
      seen.droppedCount = droppedMessages.length;
      seen.model = model;
      seen.maxOutputTokens = maxOutputTokens;
      return "summary-ok";
    };
    // Build a long-enough conversation so the fitter drops middle msgs.
    // claude-opus-4-7 context window is 200k → safe budget ~160k.
    // We synthesize ~200 messages of ~6k tokens each (~24k chars).
    const messages = [];
    messages.push({ role: "system", content: "you are helpful" });
    const big = "x".repeat(24_000);
    for (let i = 0; i < 60; i++) {
      messages.push({ role: i % 2 ? "assistant" : "user", content: big + ` #${i}` });
    }
    const out = await compactContext({
      messages,
      model: "claude-opus-4-7",
      reservedCompletionTokens: 999_999, // intentionally absurd
      summarizer,
    });
    const ceiling = getCompletionLimit("claude-opus-4-7");
    assert.ok(out.stats.dropped_messages > 0, "expected fitter to drop middle messages");
    assert.equal(out.stats.summarized, true);
    assert.equal(seen.model, "claude-opus-4-7");
    assert.ok(seen.maxOutputTokens > 0);
    assert.ok(seen.maxOutputTokens <= ceiling, `summarizer got ${seen.maxOutputTokens} > ceiling ${ceiling}`);
    assert.ok(seen.maxOutputTokens <= Math.floor(ceiling * DEFAULT_SUMMARY_OUTPUT_SHARE));
    assert.equal(out.stats.summary_max_output_tokens, seen.maxOutputTokens);
    assert.ok(out.stats.reserved_completion_tokens > 0);
    assert.ok(out.stats.reserved_completion_tokens <= ceiling);
  });

  test("does not invoke summarizer when nothing was dropped", async () => {
    let called = 0;
    const summarizer = async () => {
      called++;
      return "x";
    };
    const out = await compactContext({
      messages: [
        { role: "system", content: "hi" },
        { role: "user", content: "hello" },
      ],
      model: "gpt-4o",
      summarizer,
    });
    assert.equal(called, 0);
    assert.equal(out.stats.summarized, false);
    assert.equal(out.stats.dropped_messages, 0);
    // Stats are still reported.
    assert.ok(out.stats.reserved_completion_tokens >= 0);
    assert.ok(out.stats.summary_max_output_tokens > 0);
  });

  test("summary_max_output_tokens is reported even with no summarizer", async () => {
    const out = await compactContext({
      messages: [{ role: "user", content: "hi" }],
      model: "gemini-2.5-pro",
      reservedCompletionTokens: 8192,
    });
    const ceiling = getCompletionLimit("gemini-2.5-pro");
    assert.ok(out.stats.summary_max_output_tokens > 0);
    assert.ok(out.stats.summary_max_output_tokens <= ceiling);
  });
});
