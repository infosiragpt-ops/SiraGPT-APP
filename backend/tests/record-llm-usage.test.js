/**
 * record-llm-usage — pins the "compute cost + best-effort emit"
 * contract. The actual SDK calls (PostHog / Langfuse) are stubbed
 * out by replacing globals on the modules they import; we verify:
 *
 *   1. Cost is computed correctly via llm-cost (sanity check that
 *      we forward args through).
 *   2. Both observability emits happen when configured.
 *   3. SDK errors are swallowed — observability NEVER breaks the
 *      request path.
 *   4. Anonymous traffic (no userId) skips PostHog but still
 *      computes the cost (caller might want it for billing).
 */

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// We test the FULL helper behavior including cost computation.
// To intercept the observability emits we override the methods
// the helper imports from posthog.js / langfuse.js modules.
const posthogModule = require("../src/services/observability/posthog");
const langfuseModule = require("../src/services/observability/langfuse");
const { recordLLMUsage } = require("../src/services/observability/record-llm-usage");

let posthogCalls = [];
let langfuseCalls = [];
const originalCapture = posthogModule.capturePostHogEvent;
const originalTrace = langfuseModule.traceLLMGeneration;

function installStubs({ posthogThrows = false, langfuseThrows = false } = {}) {
  posthogModule.capturePostHogEvent = (event) => {
    posthogCalls.push(event);
    if (posthogThrows) throw new Error("posthog SDK exploded");
    return true;
  };
  langfuseModule.traceLLMGeneration = (event) => {
    langfuseCalls.push(event);
    if (langfuseThrows) throw new Error("langfuse SDK exploded");
    return true;
  };
}

function restoreStubs() {
  posthogModule.capturePostHogEvent = originalCapture;
  langfuseModule.traceLLMGeneration = originalTrace;
}

beforeEach(() => {
  posthogCalls = [];
  langfuseCalls = [];
  installStubs();
});

describe("recordLLMUsage — cost computation", () => {
  test("forwards args to calculateCost and returns the structured cost", () => {
    const result = recordLLMUsage({
      userId: "u-1",
      surface: "chat.text-turn",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 2000,
    });
    // 1000 input × $2.5/1M = 0.0025; 2000 output × $10/1M = 0.020; total 0.0225.
    assert.equal(result.input_cost_usd, 0.0025);
    assert.equal(result.output_cost_usd, 0.02);
    assert.equal(result.cost_usd, 0.0225);
    assert.equal(result.source, "pricing-table");
    restoreStubs();
  });

  test("unknown model falls back without throwing", () => {
    const result = recordLLMUsage({
      userId: "u-1",
      surface: "chat",
      model: "totally-not-real",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    assert.equal(result.source, "fallback");
    assert.ok(result.cost_usd > 0);
    restoreStubs();
  });
});

describe("recordLLMUsage — PostHog emit", () => {
  test("emits llm.generation.completed with non-PII properties", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "chat.text-turn",
      model: "gpt-4o",
      provider: "OpenAI",
      inputTokens: 1000,
      outputTokens: 500,
      latencyMs: 1200,
      chatId: "chat-42",
    });
    assert.equal(posthogCalls.length, 1);
    const [call] = posthogCalls;
    assert.equal(call.distinctId, "u-1");
    assert.equal(call.event, "llm.generation.completed");
    assert.equal(call.properties.surface, "chat.text-turn");
    assert.equal(call.properties.model, "gpt-4o");
    assert.equal(call.properties.provider, "OpenAI");
    assert.equal(call.properties.input_tokens, 1000);
    assert.equal(call.properties.output_tokens, 500);
    assert.equal(call.properties.total_tokens, 1500);
    assert.equal(call.properties.latency_ms, 1200);
    assert.equal(call.properties.chat_id, "chat-42");
    assert.ok(call.properties.cost_usd > 0);
    // Verify NO prompt / response text leaked into properties.
    const propStr = JSON.stringify(call.properties);
    assert.ok(!propStr.includes("prompt"));
    assert.ok(!propStr.includes("response"));
    restoreStubs();
  });

  test("anonymous traffic (no userId) → no PostHog call but cost still returned", () => {
    const result = recordLLMUsage({
      surface: "chat",
      model: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 100,
    });
    assert.equal(posthogCalls.length, 0);
    assert.ok(result.cost_usd > 0);
    restoreStubs();
  });

  test("PostHog SDK throwing is swallowed — caller never sees the error", () => {
    restoreStubs();
    installStubs({ posthogThrows: true });
    assert.doesNotThrow(() => {
      recordLLMUsage({
        userId: "u-1",
        surface: "chat",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 100,
      });
    });
    // Langfuse should still have been called.
    assert.equal(langfuseCalls.length, 1);
    restoreStubs();
  });
});

describe("recordLLMUsage — Langfuse emit", () => {
  test("emits trace with input/output/total cost split", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "agent.run",
      model: "claude-sonnet-4.5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      sessionId: "session-abc",
    });
    assert.equal(langfuseCalls.length, 1);
    const [call] = langfuseCalls;
    assert.equal(call.name, "agent.run");
    assert.equal(call.model, "claude-sonnet-4.5");
    assert.equal(call.userId, "u-1");
    assert.equal(call.sessionId, "session-abc");
    assert.equal(call.usage.promptTokens, 1_000_000);
    assert.equal(call.usage.completionTokens, 1_000_000);
    assert.equal(call.usage.input, 3);   // sonnet input rate × 1M
    assert.equal(call.usage.output, 15); // sonnet output rate × 1M
    assert.equal(call.usage.total, 18);
    assert.equal(call.metadata.provider, "Anthropic");
    restoreStubs();
  });

  test("Langfuse SDK throwing is swallowed", () => {
    restoreStubs();
    installStubs({ langfuseThrows: true });
    assert.doesNotThrow(() => {
      recordLLMUsage({
        userId: "u-1",
        surface: "chat",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 100,
      });
    });
    // PostHog should still have been called.
    assert.equal(posthogCalls.length, 1);
    restoreStubs();
  });

  test("missing sessionId falls back to chatId for Langfuse session grouping", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "chat",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
      chatId: "chat-fallback",
    });
    const [call] = langfuseCalls;
    assert.equal(call.sessionId, "chat-fallback");
    restoreStubs();
  });

  test("metadata is forwarded with provider + cost_source layered in", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "chat",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
      metadata: { custom_field: "value-42" },
    });
    const [call] = langfuseCalls;
    assert.equal(call.metadata.custom_field, "value-42");
    assert.equal(call.metadata.provider, "OpenAI");
    assert.equal(call.metadata.cost_source, "pricing-table");
    restoreStubs();
  });
});

describe("recordLLMUsage — defensive arithmetic", () => {
  test("invalid token counts (NaN, negative) clamp to 0 in emitted properties", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "chat",
      model: "gpt-4o",
      inputTokens: NaN,
      outputTokens: -5,
    });
    const [call] = posthogCalls;
    assert.equal(call.properties.input_tokens, 0);
    assert.equal(call.properties.output_tokens, 0);
    assert.equal(call.properties.total_tokens, 0);
    restoreStubs();
  });

  test("missing latencyMs surfaces as null (not NaN) in dashboards", () => {
    recordLLMUsage({
      userId: "u-1",
      surface: "chat",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
      // no latencyMs
    });
    const [call] = posthogCalls;
    assert.equal(call.properties.latency_ms, null);
    restoreStubs();
  });
});
