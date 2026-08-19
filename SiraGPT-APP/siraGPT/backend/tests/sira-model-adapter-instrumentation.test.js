/**
 * sira-model-adapter-instrumentation — verifies the wiring between
 * `model-adapter.callUserSelectedModel` and `llm-instrumentation`:
 * circuit-breaker pre-check, success recording, error recording, and
 * the no-instrument escape hatch for tests.
 */

const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const modelAdapter = require("../src/services/sira/model-adapter");
const llm = require("../src/services/sira/llm-instrumentation");
const metrics = require("../src/services/agents/metrics");

beforeEach(() => {
  llm._resetForTests();
  metrics._reset();
});

function fakeProviders({ behavior = "ok" } = {}) {
  // Returns a provider map that records every call so we can assert
  // the dispatch path. `behavior`:
  //   - "ok"     → returns a synthetic response with usage + raw cost
  //   - "throw"  → throws on dispatch
  return {
    openai: async ({ selectedModel, messages }) => {
      if (behavior === "throw") throw new Error("upstream 502");
      const text = `[fake:${selectedModel.modelId}] ack ${messages.length} msgs`;
      return {
        text,
        parsed: null,
        usage: { input_tokens: 100, output_tokens: 50 },
        raw: null,
      };
    },
  };
}

const baseArgs = {
  selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
  systemPrompt: "you are siraGPT",
  messages: [{ role: "user", content: "hi" }],
};

// ── Success path ──────────────────────────────────────────────────

describe("instrumentation on success", () => {
  test("records a success call and emits all five metrics", async () => {
    await modelAdapter.callUserSelectedModel(baseArgs, {
      providers: fakeProviders(),
      userPlan: "PRO", userId: "u-1",
    });
    const text = metrics.renderText();
    assert.match(text, /sira_llm_calls_total\{provider="openai",model="gpt-4o-mini",status="success"\} 1/);
    assert.match(text, /sira_llm_call_duration_ms_count\{provider="openai",model="gpt-4o-mini"\} 1/);
    assert.match(text, /sira_llm_tokens_total\{provider="openai",model="gpt-4o-mini",direction="input"\} 100/);
    assert.match(text, /sira_llm_tokens_total\{provider="openai",model="gpt-4o-mini",direction="output"\} 50/);
  });

  test("appends a record to the cost ledger with the user metadata", async () => {
    await modelAdapter.callUserSelectedModel(baseArgs, {
      providers: fakeProviders(),
      userPlan: "FREE", userId: "u-led",
    });
    const ledger = llm.getCostLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].provider, "openai");
    assert.equal(ledger[0].model, "gpt-4o-mini");
    assert.equal(ledger[0].status, "success");
    assert.equal(ledger[0].user_plan, "FREE");
    assert.equal(ledger[0].user_id, "u-led");
    assert.equal(ledger[0].input_tokens, 100);
    assert.equal(ledger[0].output_tokens, 50);
  });
});

// ── Error path ────────────────────────────────────────────────────

describe("instrumentation on error", () => {
  test("records a failure when the provider throws and re-raises", async () => {
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel(baseArgs, { providers: fakeProviders({ behavior: "throw" }) }),
      /upstream 502/,
    );
    const text = metrics.renderText();
    assert.match(text, /sira_llm_calls_total\{provider="openai",model="gpt-4o-mini",status="error"\} 1/);
    const ledger = llm.getCostLedger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, "error");
  });

  test("opens the circuit after the configured failure threshold", async () => {
    llm.configure({ failuresToOpen: 2 });
    for (let i = 0; i < 2; i++) {
      try {
        await modelAdapter.callUserSelectedModel(baseArgs, { providers: fakeProviders({ behavior: "throw" }) });
      } catch (_) {}
    }
    assert.equal(llm.getCircuitState("openai"), "open");
    assert.equal(llm.isProviderAvailable("openai"), false);
  });
});

// ── Circuit pre-check ─────────────────────────────────────────────

describe("circuit pre-check", () => {
  test("refuses to dispatch when the circuit is open", async () => {
    llm.configure({ failuresToOpen: 1 });
    // Trip the circuit explicitly via a recorded failure.
    llm.recordLlmCall({
      selectedModel: { provider: "openai", modelId: "gpt-4o-mini" },
      status: "error", errorCode: "boom",
    });
    assert.equal(llm.getCircuitState("openai"), "open");

    let dispatched = 0;
    const providers = {
      openai: async () => { dispatched += 1; return { text: "x", usage: {} }; },
    };
    await assert.rejects(
      () => modelAdapter.callUserSelectedModel(baseArgs, { providers }),
      (err) => err && err.code === "provider_circuit_open",
    );
    assert.equal(dispatched, 0, "provider must not be invoked when circuit is open");
  });

  test("half_open allows one trial call", async () => {
    let t = 0;
    llm.configure({ failuresToOpen: 1, cooldownMs: 100, now: () => t });
    llm.recordLlmCall({
      selectedModel: { provider: "openai", modelId: "x" },
      status: "error",
    });
    t += 200; // cooldown elapsed
    assert.equal(llm.getCircuitState("openai"), "half_open");
    await modelAdapter.callUserSelectedModel(baseArgs, { providers: fakeProviders() });
    // Trial succeeded → circuit should close.
    assert.equal(llm.getCircuitState("openai"), "closed");
  });
});

// ── Escape hatch ──────────────────────────────────────────────────

describe("instrument: false", () => {
  test("skips the recorder so legacy tests stay clean", async () => {
    await modelAdapter.callUserSelectedModel(baseArgs, {
      providers: fakeProviders(),
      instrument: false,
    });
    const text = metrics.renderText();
    assert.doesNotMatch(text, /sira_llm_calls_total\{provider="openai"/);
    assert.equal(llm.getCostLedger().length, 0);
  });
});
