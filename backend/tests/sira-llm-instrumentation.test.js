/**
 * sira-llm-instrumentation — circuit breaker + cost ledger + metrics
 * recording for LLM calls. Closes task 8 of the expanded vision.
 */

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const llm = require("../src/services/sira/llm-instrumentation");
const metrics = require("../src/services/agents/metrics");

beforeEach(() => {
  llm._resetForTests();
  metrics._reset();
});

// ── Recording ──────────────────────────────────────────────────────

describe("recordLlmCall", () => {
  test("emits counter, histogram, tokens, and cost metrics", () => {
    llm.recordLlmCall({
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      durationMs: 850,
      usage: { input_tokens: 120, output_tokens: 480 },
      costUsd: 0.0042,
      status: "success",
    });
    const text = metrics.renderText();
    assert.match(text, /sira_llm_calls_total\{provider="openai",model="gpt-4o-mini",status="success"\} 1/);
    assert.match(text, /sira_llm_tokens_total\{provider="openai",model="gpt-4o-mini",direction="input"\} 120/);
    assert.match(text, /sira_llm_tokens_total\{provider="openai",model="gpt-4o-mini",direction="output"\} 480/);
    // 0.0042 USD = 4200 micro-USD
    assert.match(text, /sira_llm_cost_micro_usd_total\{provider="openai",model="gpt-4o-mini"\} 4200/);
    assert.match(text, /sira_llm_call_duration_ms_count\{provider="openai",model="gpt-4o-mini"\} 1/);
  });

  test("appends to the ledger with the right shape", () => {
    llm.recordLlmCall({
      selectedModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      durationMs: 1200, usage: { input_tokens: 50, output_tokens: 200 },
      costUsd: 0.0015, status: "success", userPlan: "PRO",
    });
    const ledger = llm.getCostLedger();
    assert.equal(ledger.length, 1);
    const r = ledger[0];
    assert.equal(r.provider, "anthropic");
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.status, "success");
    assert.equal(r.duration_ms, 1200);
    assert.equal(r.input_tokens, 50);
    assert.equal(r.output_tokens, 200);
    assert.equal(r.cost_usd, 0.0015);
    assert.equal(r.user_plan, "PRO");
    assert.ok(Number.isFinite(r.ts));
  });

  test("ledger cap drops oldest entries past the configured size", () => {
    llm.configure({ ledgerCap: 3 });
    for (let i = 0; i < 5; i++) {
      llm.recordLlmCall({
        selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
        status: "success",
      });
    }
    assert.equal(llm.getCostLedger().length, 3);
  });
});

// ── Circuit breaker ────────────────────────────────────────────────

describe("circuit breaker", () => {
  test("starts closed; closed-success keeps it closed", () => {
    assert.equal(llm.getCircuitState("openai"), "closed");
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "success" });
    assert.equal(llm.getCircuitState("openai"), "closed");
    assert.equal(llm.isProviderAvailable("openai"), true);
  });

  test("opens after N consecutive failures", () => {
    llm.configure({ failuresToOpen: 3 });
    for (let i = 0; i < 3; i++) {
      llm.recordLlmCall({
        selectedModel: { provider: "openai", modelId: "x" },
        status: "error", errorCode: "tool.upstream_5xx",
      });
    }
    assert.equal(llm.getCircuitState("openai"), "open");
    assert.equal(llm.isProviderAvailable("openai"), false);
  });

  test("a single success resets the failure counter while still closed", () => {
    llm.configure({ failuresToOpen: 3 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "success" });
    // First failure was reset; we need 3 fresh failures to open.
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    assert.equal(llm.getCircuitState("openai"), "closed", "should still be closed after 2 fresh failures");
  });

  test("transitions open → half_open after cooldown", () => {
    let t = 1000;
    llm.configure({ failuresToOpen: 2, cooldownMs: 5000, now: () => t });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    assert.equal(llm.getCircuitState("openai"), "open");
    t += 4000;
    assert.equal(llm.getCircuitState("openai"), "open"); // not yet
    t += 2000;
    assert.equal(llm.getCircuitState("openai"), "half_open");
    assert.equal(llm.isProviderAvailable("openai"), true);
  });

  test("any failure in half_open flips back to open", () => {
    let t = 0;
    llm.configure({ failuresToOpen: 1, cooldownMs: 100, now: () => t });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    t += 200;
    assert.equal(llm.getCircuitState("openai"), "half_open");
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    assert.equal(llm.getCircuitState("openai"), "open");
  });

  test("success in half_open closes the circuit (with successesToClose=1)", () => {
    let t = 0;
    llm.configure({ failuresToOpen: 1, cooldownMs: 100, successesToClose: 1, now: () => t });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    t += 200;
    assert.equal(llm.getCircuitState("openai"), "half_open");
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "success" });
    assert.equal(llm.getCircuitState("openai"), "closed");
  });

  test("circuits are per-provider — one provider opening does not affect another", () => {
    llm.configure({ failuresToOpen: 2 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    assert.equal(llm.getCircuitState("openai"), "open");
    assert.equal(llm.getCircuitState("anthropic"), "closed");
    assert.equal(llm.isProviderAvailable("anthropic"), true);
  });

  test("circuit-state gauge reflects transitions", () => {
    llm.configure({ failuresToOpen: 1 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    const text = metrics.renderText();
    assert.match(text, /sira_llm_circuit_state\{provider="openai"\} 2/);
  });
});

// ── Cost summary ───────────────────────────────────────────────────

describe("getCostSummary", () => {
  test("aggregates per provider+model by default", () => {
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "gpt-4o-mini" }, costUsd: 0.001, usage: { input_tokens: 10, output_tokens: 20 } });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "gpt-4o-mini" }, costUsd: 0.002, usage: { input_tokens: 5, output_tokens: 5 } });
    llm.recordLlmCall({ selectedModel: { provider: "anthropic", modelId: "claude-haiku-4-5" }, costUsd: 0.0001, usage: { input_tokens: 3, output_tokens: 7 } });
    const s = llm.getCostSummary();
    assert.equal(s["provider=openai|model=gpt-4o-mini"].calls, 2);
    assert.equal(s["provider=openai|model=gpt-4o-mini"].cost_usd, 0.003);
    assert.equal(s["provider=openai|model=gpt-4o-mini"].input_tokens, 15);
    assert.equal(s["provider=anthropic|model=claude-haiku-4-5"].calls, 1);
  });

  test("tracks failures per dimension", () => {
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "success", costUsd: 0.01 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, status: "error" });
    const s = llm.getCostSummary();
    const k = "provider=openai|model=x";
    assert.equal(s[k].calls, 2);
    assert.equal(s[k].failures, 1);
  });

  test("respects time window (since/until)", () => {
    let t = 1000;
    llm.configure({ now: () => t });
    llm.recordLlmCall({ selectedModel: { provider: "p", modelId: "m" }, costUsd: 1 });
    t = 5000;
    llm.recordLlmCall({ selectedModel: { provider: "p", modelId: "m" }, costUsd: 1 });
    t = 9000;
    llm.recordLlmCall({ selectedModel: { provider: "p", modelId: "m" }, costUsd: 1 });
    const s = llm.getCostSummary({ since: 4000, until: 8000 });
    assert.equal(s["provider=p|model=m"].calls, 1);
  });

  test("supports custom dimensions like user_plan", () => {
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, userPlan: "FREE", costUsd: 0.001 });
    llm.recordLlmCall({ selectedModel: { provider: "openai", modelId: "x" }, userPlan: "PRO", costUsd: 0.005 });
    const s = llm.getCostSummary({ dimensions: ["user_plan"] });
    assert.equal(s["user_plan=FREE"].cost_usd, 0.001);
    assert.equal(s["user_plan=PRO"].cost_usd, 0.005);
  });
});
