import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SIRA_PRO_LABEL, SIRA_RAPIDO_LABEL } from "../lib/chat/brand-label"
import {
  prettifyPickedModelLabel,
  resolvePickerBadgeSource,
  resolveReplyBadgeLabel,
} from "../lib/chat/reply-badge-model"

describe("reply badge follows the picker, not Sira Rápido", () => {
  const catalog = [
    { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "xAI" },
    { name: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", provider: "Anthropic" },
    { name: "google/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", provider: "Gemini" },
    { name: "deepseek-v4-flash", displayName: "Sira Rápido", provider: "DeepSeek" },
    { name: "deepseek-v4-pro", displayName: "Sira Pro", provider: "DeepSeek" },
  ]

  it("labels a Grok reply Grok 4.5, never Sira Rápido", () => {
    const label = resolveReplyBadgeLabel({
      generationUsage: { model: "x-ai/grok-4.5" },
      metadata: { generationUsage: { model: "x-ai/grok-4.5" }, pickerModel: "x-ai/grok-4.5" },
    }, catalog)
    assert.equal(label, "Grok 4.5")
    assert.notEqual(label, SIRA_RAPIDO_LABEL)
  })

  it("labels Claude / Gemini from persisted usage metadata after reload", () => {
    assert.equal(
      resolveReplyBadgeLabel({
        metadata: JSON.stringify({ generationUsage: { model: "anthropic/claude-sonnet-5" } }),
      }, catalog),
      "Claude Sonnet 5",
    )
    assert.equal(
      resolveReplyBadgeLabel({
        generationUsage: { model: "google/gemini-3.5-flash" },
      }, catalog),
      "Gemini 3.5 Flash",
    )
  })

  it("keeps Sira aliases only for in-house Flash / Pro", () => {
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "deepseek-v4-flash" } }, catalog),
      SIRA_RAPIDO_LABEL,
    )
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "deepseek-v4-pro" } }, catalog),
      SIRA_PRO_LABEL,
    )
  })

  it("does not invent Sira Rápido when the message has no model", () => {
    assert.equal(resolveReplyBadgeLabel({ content: "Hola" } as never, catalog), "")
    assert.equal(resolveReplyBadgeLabel({}, catalog), "")
    assert.equal(resolveReplyBadgeLabel(null, catalog), "")
  })

  it("never leaks DeepSeek, OpenRouter, or a raw vendor slug", () => {
    assert.equal(prettifyPickedModelLabel("x-ai/grok-4.5"), "Grok 4.5")
    assert.equal(prettifyPickedModelLabel("anthropic/claude-sonnet-5"), "Claude Sonnet 5")
    assert.equal(prettifyPickedModelLabel("openrouter/gpt-4o"), "")
    assert.doesNotMatch(prettifyPickedModelLabel("x-ai/grok-4.5"), /openrouter|deepseek|x-ai\//i)
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "x-ai/grok-4.5" } }),
      "Grok 4.5",
    )
  })

  it("stamps the picker descriptor used on the live placeholder", () => {
    assert.deepEqual(
      resolvePickerBadgeSource("x-ai/grok-4.5", catalog, "Kimi"),
      { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "xAI" },
    )
  })
})
