import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  deriveComposerContextSnapshot,
  formatCompactTokens,
  formatUsd,
  readMessageGenerationUsage,
  resolveDisplayTotalCost,
} from "../lib/chat/composer-context-usage"

describe("composer context usage", () => {
  it("derives the reference 262.8k / 500k context metric as 53%", () => {
    const latestUsage = {
      model: "grok-4.6",
      contextTokens: 262_800,
      tokensIn: 263_000,
      tokensOut: 1_100,
      costAppliedUsd: 0.926,
      costInputUsd: 0.0003,
      costOutputUsd: 0.0017,
      costCacheReadUsd: 0.131,
    }

    assert.deepEqual(deriveComposerContextSnapshot({
      messages: [{ role: "ASSISTANT", generationUsage: latestUsage }],
      selectedModel: "grok-4.6",
      availableModels: [{ name: "grok-4.6", contextLength: 500_000 }],
    }), {
      contextTokens: 262_800,
      contextWindow: 500_000,
      percentage: 53,
      latestUsage,
    })
  })

  it("formats the reference token and USD values without losing precision", () => {
    assert.equal(formatCompactTokens(262_800), "262.8k")
    assert.equal(formatCompactTokens(500_000), "500k")
    assert.equal(formatCompactTokens(263_000), "263k")
    assert.equal(formatCompactTokens(1_100), "1.1k")
    assert.equal(formatCompactTokens(999), "999")
    assert.equal(formatCompactTokens(1_000_000), "1m")

    assert.equal(formatUsd(0.0003), "$0.0003")
    assert.equal(formatUsd(0.0017), "$0.0017")
    assert.equal(formatUsd(0.131), "$0.131")
    assert.equal(formatUsd(0.926), "$0.926")
    assert.equal(formatUsd(2), "$2.00")
    assert.equal(resolveDisplayTotalCost({
      costOriginalUsd: 0.926,
      costTotalUsd: 0.926,
      costAppliedUsd: 0.695,
    }), 0.695, "the plan-applied cost must win over provider list price")
  })

  it("renders unavailable and invalid metrics as an em dash", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.equal(formatCompactTokens(value), "—")
      assert.equal(formatUsd(value), "—")
    }

    assert.deepEqual(deriveComposerContextSnapshot({
      messages: [],
      selectedModel: "unknown-model",
      availableModels: [],
    }), {
      contextTokens: null,
      contextWindow: null,
      percentage: null,
      latestUsage: null,
    })
  })

  it("hydrates generation usage from persisted object or JSON metadata", () => {
    const stored = {
      model: "grok-4.6",
      tokensIn: 263_000,
      tokensOut: 1_100,
      contextTokens: 262_800,
      contextWindow: 500_000,
      costAppliedUsd: 0.926,
    }

    assert.deepEqual(readMessageGenerationUsage({
      metadata: { generationUsage: stored },
    }), stored)
    assert.deepEqual(readMessageGenerationUsage({
      metadata: JSON.stringify({ generationUsage: stored }),
    }), stored)
    assert.equal(readMessageGenerationUsage({ metadata: "not-json" }), null)

    assert.deepEqual(readMessageGenerationUsage({
      generationUsage: { model: "direct", tokensIn: 7 },
      metadata: { generationUsage: stored },
    }), { model: "direct", tokensIn: 7 }, "live usage must win over persisted metadata")
  })

  it("keeps latest-run rows while isolating the active model context metric", () => {
    const selectedUsage = {
      model: "grok-4.6",
      contextTokens: 120_000,
      tokensIn: 121_000,
      tokensOut: 500,
    }
    const otherUsage = {
      model: "gemini-3.5-flash",
      contextTokens: 400_000,
      tokensIn: 401_000,
      tokensOut: 2_000,
    }
    const models = [
      { id: "model-grok", name: "grok-4.6", contextLength: 500_000 },
      { id: "model-gemini", name: "gemini-3.5-flash", contextLength: 1_000_000 },
    ]

    const matchingSnapshot = deriveComposerContextSnapshot({
      messages: [
        { role: "ASSISTANT", generationUsage: selectedUsage },
        { role: "ASSISTANT", generationUsage: otherUsage },
      ],
      selectedModel: "GROK-4.6",
      availableModels: models,
    })
    assert.equal(matchingSnapshot.latestUsage?.model, "gemini-3.5-flash")
    assert.equal(matchingSnapshot.contextTokens, null)
    assert.equal(matchingSnapshot.contextWindow, 500_000)
    assert.equal(matchingSnapshot.percentage, null)

    assert.deepEqual(deriveComposerContextSnapshot({
      messages: [{ role: "ASSISTANT", generationUsage: otherUsage }],
      selectedModel: "model-grok",
      availableModels: models,
    }), {
      contextTokens: null,
      contextWindow: 500_000,
      percentage: null,
      latestUsage: otherUsage,
    })
  })

  it("prefers the selected catalog context length over a stale usage fallback", () => {
    assert.equal(deriveComposerContextSnapshot({
      messages: [{
        role: "ASSISTANT",
        generationUsage: {
          model: "grok-4.6",
          contextTokens: 4_096,
          contextWindow: 8_192,
        },
      }],
      selectedModel: "grok-4.6",
      availableModels: [{ name: "grok-4.6", contextLength: 500_000 }],
    }).contextWindow, 500_000)
  })
})
