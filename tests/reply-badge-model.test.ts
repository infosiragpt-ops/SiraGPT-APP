import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DEEPSEEK_FLASH_LABEL, DEEPSEEK_PRO_LABEL } from "../lib/chat/brand-label"
import {
  prettifyPickedModelLabel,
  resolvePickerBadgeSource,
  resolveReplyBadgeLabel,
} from "../lib/chat/reply-badge-model"

describe("reply badge follows the picker, not DeepSeek V4 Flash by default", () => {
  const catalog = [
    { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "xAI" },
    { name: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", provider: "Anthropic" },
    { name: "google/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", provider: "Gemini" },
    { name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", provider: "DeepSeek" },
    { name: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", provider: "DeepSeek" },
  ]

  it("labels persisted grok-4.5 (DB passthrough) Grok 4.5, not curated Grok 4.2", () => {
    const catalog42 = [
      { name: "x-ai/grok-4.20", displayName: "Grok 4.2", provider: "xAI" },
    ]
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "grok-4.5" } }, catalog42),
      "Grok 4.5",
    )
    assert.equal(
      resolveReplyBadgeLabel({
        metadata: { generationUsage: { model: "grok-4.5" } },
      }, catalog42),
      "Grok 4.5",
    )
    assert.notEqual(
      resolveReplyBadgeLabel({ generationUsage: { model: "grok-4.5" } }, catalog42),
      "Grok 4.2",
    )
  })

  it("labels a Grok reply Grok 4.5, never DeepSeek V4 Flash", () => {
    const label = resolveReplyBadgeLabel({
      generationUsage: { model: "x-ai/grok-4.5" },
      metadata: { generationUsage: { model: "x-ai/grok-4.5" }, pickerModel: "x-ai/grok-4.5" },
    }, catalog)
    assert.equal(label, "Grok 4.5")
    assert.notEqual(label, DEEPSEEK_FLASH_LABEL)
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

  it("labels DeepSeek V4 Flash / Pro replies with their original names", () => {
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "deepseek-v4-flash" } }, catalog),
      DEEPSEEK_FLASH_LABEL,
    )
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "deepseek-v4-pro" } }, catalog),
      DEEPSEEK_PRO_LABEL,
    )
    assert.equal(DEEPSEEK_FLASH_LABEL, "DeepSeek V4 Flash")
    assert.equal(DEEPSEEK_PRO_LABEL, "DeepSeek V4 Pro")
  })

  it("re-labels older replies stored with the legacy Sira aliases", () => {
    const legacyCatalog = [
      { name: "deepseek-v4-flash", displayName: "Sira Rápido", provider: "DeepSeek" },
      { name: "deepseek-v4-pro", displayName: "Sira Pro", provider: "DeepSeek" },
    ]
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "deepseek-v4-pro" } }, legacyCatalog),
      DEEPSEEK_PRO_LABEL,
    )
    assert.equal(
      resolveReplyBadgeLabel({
        metadata: { generationUsage: { model: "deepseek-v4-flash" }, pickerModel: "deepseek-v4-flash", pickerDisplayName: "Sira Rápido" },
      }, legacyCatalog),
      DEEPSEEK_FLASH_LABEL,
    )
    assert.equal(
      resolveReplyBadgeLabel({ metadata: { pickerModel: "deepseek-v4-pro", pickerDisplayName: "Sira Pro" } }),
      DEEPSEEK_PRO_LABEL,
    )
    assert.deepEqual(
      resolvePickerBadgeSource("deepseek-v4-flash", legacyCatalog, "DeepSeek"),
      { name: "deepseek-v4-flash", displayName: "Sira Rápido", provider: "DeepSeek" },
    )
  })

  it("does not invent DeepSeek V4 Flash when the message has no model", () => {
    assert.equal(resolveReplyBadgeLabel({ content: "Hola" } as never, catalog), "")
    assert.equal(resolveReplyBadgeLabel({}, catalog), "")
    assert.equal(resolveReplyBadgeLabel(null, catalog), "")
  })

  it("never leaks a raw DeepSeek id, OpenRouter, or a raw vendor slug", () => {
    assert.equal(prettifyPickedModelLabel("x-ai/grok-4.5"), "Grok 4.5")
    assert.equal(prettifyPickedModelLabel("anthropic/claude-sonnet-5"), "Claude Sonnet 5")
    assert.equal(prettifyPickedModelLabel("openrouter/gpt-4o"), "")
    assert.equal(prettifyPickedModelLabel("deepseek/deepseek-v4-pro"), DEEPSEEK_PRO_LABEL)
    assert.equal(prettifyPickedModelLabel("deepseek-reasoner"), "DeepSeek Reasoner")
    assert.doesNotMatch(prettifyPickedModelLabel("x-ai/grok-4.5"), /openrouter|deepseek|x-ai\//i)
    for (const raw of ["deepseek-v4-flash", "deepseek/deepseek-v4-pro", "deepseek-chat"]) {
      assert.doesNotMatch(resolveReplyBadgeLabel({ generationUsage: { model: raw } }, catalog), /deepseek[-_/:]|openrouter/i, raw)
    }
    assert.equal(
      resolveReplyBadgeLabel({ generationUsage: { model: "x-ai/grok-4.5" } }),
      "Grok 4.5",
    )
  })

  it("names the model that actually answered after a billing failover", () => {
    const failedOver = {
      model: "claude-fable-5-1",
      metadata: { modelFailover: { reason: "billing", fromLabel: "Claude Fable 5.1", toLabel: "Grok 4.7", toModel: "grok-4.7" } },
    }
    assert.equal(resolveReplyBadgeLabel(failedOver as never, catalog), "Grok 4.7")
    // A raw id never reaches the badge even through the failover path.
    const raw = { model: "claude-fable-5-1", metadata: { modelFailover: { toLabel: "deepseek/deepseek-v4-pro" } } }
    assert.doesNotMatch(resolveReplyBadgeLabel(raw as never, catalog), /deepseek[-_/:]/i)
  })

  it("stamps the picker descriptor used on the live placeholder", () => {
    assert.deepEqual(
      resolvePickerBadgeSource("x-ai/grok-4.5", catalog, "Kimi"),
      { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "xAI" },
    )
  })
})
