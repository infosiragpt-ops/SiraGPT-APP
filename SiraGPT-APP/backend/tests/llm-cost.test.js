/**
 * llm-cost — pins the pricing math + lookup behavior. Three
 * properties matter for production observability:
 *
 *   1. Known models hit the exact pricing row (no drift between
 *      what the operator sees in the dashboard and what we
 *      report to the user).
 *
 *   2. Unknown models DON'T silently report $0. They fall back to
 *      the env-tunable estimate so the cost dashboard never has
 *      gaps — operators want to KNOW about an unmapped model,
 *      not pretend it was free.
 *
 *   3. Defensive arithmetic: negative or NaN token counts are
 *      clamped, never propagate as NaN into the analytics stream.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateCost,
  getModelPricing,
  listKnownModels,
  resolveCostConfig,
  normalizeModelKey,
  PRICING_TABLE,
  DEFAULT_FALLBACK_PER_MILLION,
} = require("../src/services/observability/llm-cost");

describe("getModelPricing", () => {
  test("exact match returns the pricing row", () => {
    const p = getModelPricing("gpt-4o");
    assert.equal(p.input, 2.5);
    assert.equal(p.output, 10);
    assert.equal(p.provider, "OpenAI");
  });

  test("case-insensitive lookup", () => {
    assert.deepEqual(getModelPricing("GPT-4o"), getModelPricing("gpt-4o"));
  });

  test("strips an OpenRouter-style provider prefix", () => {
    // openai/gpt-4o-mini falls back to the bare gpt-4o-mini row.
    const withPrefix = getModelPricing("openai/gpt-4o-mini");
    assert.notEqual(withPrefix, null);
    assert.equal(withPrefix.input, 0.15);
  });

  test("unknown model returns null", () => {
    assert.equal(getModelPricing("totally-not-a-real-model-2026"), null);
  });

  test("nullish input is defensive", () => {
    assert.equal(getModelPricing(null), null);
    assert.equal(getModelPricing(undefined), null);
    assert.equal(getModelPricing(""), null);
    assert.equal(getModelPricing(42), null);
  });
});

describe("calculateCost — pricing-table path", () => {
  test("gpt-4o on 1M input + 1M output = input + output rate", () => {
    const c = calculateCost({ model: "gpt-4o", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(c.input_cost_usd, 2.5);
    assert.equal(c.output_cost_usd, 10);
    assert.equal(c.cost_usd, 12.5);
    assert.equal(c.currency, "USD");
    assert.equal(c.source, "pricing-table");
    assert.equal(c.provider, "OpenAI");
  });

  test("scales linearly for sub-million counts (1000 tokens)", () => {
    const c = calculateCost({ model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 2000 });
    // 1k input × $0.15/1M = $0.00015; 2k output × $0.60/1M = $0.0012; total $0.00135
    assert.equal(c.input_cost_usd, 0.00015);
    assert.equal(c.output_cost_usd, 0.0012);
    assert.equal(c.cost_usd, 0.00135);
  });

  test("rounds to 6 decimal places (no trailing FP garbage)", () => {
    const c = calculateCost({ model: "gpt-4o", inputTokens: 333, outputTokens: 0 });
    // 333 × 2.5 / 1e6 = 0.0008325 → already 6dp clean
    assert.equal(c.input_cost_usd, 0.000833);
    assert.equal(c.output_cost_usd, 0);
  });

  test("provider override replaces the table-derived provider", () => {
    const c = calculateCost({
      model: "gpt-4o",
      provider: "OpenRouter",
      inputTokens: 100,
      outputTokens: 100,
    });
    assert.equal(c.provider, "OpenRouter");
  });

  test("Anthropic Sonnet 4.5 row matches list price", () => {
    const c = calculateCost({ model: "claude-sonnet-4.5", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(c.cost_usd, 18); // 3 + 15
  });
});

describe("calculateCost — fallback path", () => {
  test("unknown model returns source:'fallback' with default rate", () => {
    const c = calculateCost({ model: "unknown-model-2030", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(c.source, "fallback");
    // 1M input × $1 + 1M output × $1 = $2 (default fallback per million applies to both).
    assert.equal(c.cost_usd, 2 * DEFAULT_FALLBACK_PER_MILLION);
  });

  test("LLM_COST_FALLBACK_PER_MILLION env override", () => {
    const c = calculateCost(
      { model: "unknown", inputTokens: 1_000_000, outputTokens: 0 },
      { LLM_COST_FALLBACK_PER_MILLION: "0.5" },
    );
    assert.equal(c.input_cost_usd, 0.5);
    assert.equal(c.cost_usd, 0.5);
  });

  test("malformed env falls back to default fallback rate", () => {
    const c = calculateCost(
      { model: "unknown", inputTokens: 1_000_000, outputTokens: 0 },
      { LLM_COST_FALLBACK_PER_MILLION: "not-a-number" },
    );
    assert.equal(c.input_cost_usd, DEFAULT_FALLBACK_PER_MILLION);
  });

  test("negative env override is rejected (would break cost math)", () => {
    const c = calculateCost(
      { model: "unknown", inputTokens: 100, outputTokens: 0 },
      { LLM_COST_FALLBACK_PER_MILLION: "-0.5" },
    );
    assert.equal(c.source, "fallback");
    // Negative rate would produce negative cost; resolver must
    // refuse it and re-use the default.
    assert.ok(c.cost_usd > 0);
  });
});

describe("calculateCost — defensive arithmetic", () => {
  test("zero tokens → source:'invalid', cost:0 (don't pollute analytics)", () => {
    const c = calculateCost({ model: "gpt-4o", inputTokens: 0, outputTokens: 0 });
    assert.equal(c.source, "invalid");
    assert.equal(c.cost_usd, 0);
  });

  test("negative tokens are clamped to 0", () => {
    const c = calculateCost({ model: "gpt-4o", inputTokens: -5, outputTokens: 100 });
    // input clamped → 0 cost on input; output 100 × $10/1M = $0.001
    assert.equal(c.input_cost_usd, 0);
    assert.equal(c.output_cost_usd, 0.001);
  });

  test("NaN tokens are clamped to 0 (don't NaN-poison the dashboard)", () => {
    const c = calculateCost({ model: "gpt-4o", inputTokens: NaN, outputTokens: 1000 });
    assert.equal(c.input_cost_usd, 0);
    assert.equal(Number.isFinite(c.cost_usd), true);
  });

  test("string token counts are coerced (Prisma BigInt → string is common)", () => {
    const c = calculateCost({ model: "gpt-4o-mini", inputTokens: "1000", outputTokens: "2000" });
    assert.equal(c.input_cost_usd, 0.00015);
    assert.equal(c.output_cost_usd, 0.0012);
  });

  test("missing model with non-zero tokens still uses fallback (no nulls in dashboard)", () => {
    const c = calculateCost({ inputTokens: 1000, outputTokens: 1000 });
    assert.equal(c.source, "fallback");
    assert.ok(c.cost_usd > 0);
  });
});

describe("listKnownModels + PRICING_TABLE", () => {
  test("listKnownModels returns a non-empty array", () => {
    const models = listKnownModels();
    assert.ok(models.length > 10);
    assert.ok(models.includes("gpt-4o"));
    assert.ok(models.includes("claude-sonnet-4.5"));
    assert.ok(models.includes("gemini-2.5-pro"));
    assert.ok(models.includes("deepseek-v4-pro"));
  });

  test("PRICING_TABLE is frozen — operators MUST commit a code change to update prices", () => {
    assert.equal(Object.isFrozen(PRICING_TABLE), true);
  });

  test("every row has both input AND output prices (not optional)", () => {
    for (const [name, row] of Object.entries(PRICING_TABLE)) {
      assert.ok(typeof row.input === "number" && row.input >= 0, `${name} input price`);
      assert.ok(typeof row.output === "number" && row.output >= 0, `${name} output price`);
      assert.ok(typeof row.provider === "string" && row.provider.length > 0, `${name} provider`);
    }
  });

  test("output is always >= input for every model (LLM economics rule)", () => {
    // Some providers charge more for output (more compute on
    // generation than encoding). Gemini Flash is unusual but still
    // follows: output >= input. Mixtral is the one tie. Verify
    // none of them invert (which would be a typo).
    for (const [name, row] of Object.entries(PRICING_TABLE)) {
      assert.ok(row.output >= row.input, `${name}: output (${row.output}) must be >= input (${row.input})`);
    }
  });
});

describe("normalizeModelKey", () => {
  test("trims + lowercases", () => {
    assert.equal(normalizeModelKey("  GPT-4o  "), "gpt-4o");
  });

  test("nullish input → empty string", () => {
    assert.equal(normalizeModelKey(undefined), "");
    assert.equal(normalizeModelKey(null), "");
  });
});

describe("resolveCostConfig", () => {
  test("default fallback when no env var", () => {
    assert.equal(resolveCostConfig({}).fallbackPerMillion, DEFAULT_FALLBACK_PER_MILLION);
  });

  test("env override is parsed", () => {
    assert.equal(
      resolveCostConfig({ LLM_COST_FALLBACK_PER_MILLION: "0.42" }).fallbackPerMillion,
      0.42,
    );
  });
});
