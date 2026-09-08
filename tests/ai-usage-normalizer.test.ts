import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { normalizeAIUsageFrame } from "../lib/api"

describe("normalizeAIUsageFrame", () => {
  it("normalizes legacy flat usage frames without losing exact costs", () => {
    assert.deepEqual(normalizeAIUsageFrame({
      type: "usage",
      model: "gemini-3.5-flash",
      tokensIn: 262_800,
      tokensOut: 1_100,
      contextTokens: 262_800,
      contextWindow: 500_000,
      costUSD: 0.926,
      costInputUsd: 0.79,
      costOutputUsd: 0.136,
      costOriginalUsd: 0.926,
      costAppliedUsd: 0.695,
    }), {
      tokensIn: 262_800,
      tokensOut: 1_100,
      model: "gemini-3.5-flash",
      contextTokens: 262_800,
      contextWindow: 500_000,
      costTotalUsd: 0.926,
      costInputUsd: 0.79,
      costOutputUsd: 0.136,
      costOriginalUsd: 0.926,
      costAppliedUsd: 0.695,
    })
  })

  it("normalizes nested tokens and nested costs", () => {
    assert.deepEqual(normalizeAIUsageFrame({
      type: "usage",
      usage: {
        model: "claude-sonnet",
        tokens: { in: 1_024, out: 256, context: 1_024 },
        contextLength: 200_000,
        costs: {
          totalUsd: 0.004,
          inputUsd: 0.003,
          outputUsd: 0.001,
          cacheReadUsd: 0.0002,
        },
      },
    }), {
      tokensIn: 1_024,
      tokensOut: 256,
      model: "claude-sonnet",
      contextTokens: 1_024,
      contextWindow: 200_000,
      costTotalUsd: 0.004,
      costInputUsd: 0.003,
      costOutputUsd: 0.001,
      costCacheReadUsd: 0.0002,
    })
  })

  it("never fabricates unavailable cache cost and drops non-finite values", () => {
    assert.deepEqual(normalizeAIUsageFrame({
      type: "usage",
      tokens: { in: 50, out: 5 },
      costUSD: Number.POSITIVE_INFINITY,
      costInputUsd: Number.NaN,
      costOutputUsd: 0.001,
    }), {
      tokensIn: 50,
      tokensOut: 5,
      costOutputUsd: 0.001,
    })
  })

  it("rejects unrelated or unusable frames", () => {
    assert.equal(normalizeAIUsageFrame({ type: "content", tokensIn: 10, tokensOut: 2 }), null)
    assert.equal(normalizeAIUsageFrame({ type: "usage", tokens: { in: "10", out: 2 } }), null)
    assert.equal(normalizeAIUsageFrame(null), null)
  })

  it("applies the same plan pricing policy to the total and cost splits", () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), "backend", "src", "routes", "ai.js"),
      "utf8",
    )
    assert.match(route, /applyPlanPricing\(userPlan, estimated\.totalUSD\)/)
    assert.match(route, /applyPlanPricing\(userPlan, estimated\.inputUSD\)\.costAppliedUsd/)
    assert.match(route, /applyPlanPricing\(userPlan, estimated\.outputUSD\)\.costAppliedUsd/)
  })
})
