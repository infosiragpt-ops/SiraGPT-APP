import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { brandModelLabel, SIRA_RAPIDO_LABEL } from "../lib/chat/brand-label"
import { resolveCatalogModel } from "../lib/chat/catalog-model"
import { resolveReplyBadgeLabel } from "../lib/chat/reply-badge-model"
import { clampDeepSeekModel } from "../lib/sse-client"

describe("user-selected model always wins", () => {
  const mini = {
    name: "sira-gpt-mini",
    displayName: "SiraGPT Mini",
    provider: "Custom",
  }
  const catalog = [
    { name: "deepseek-v4-flash", provider: "DeepSeek" },
    { name: "deepseek-v4-pro", provider: "DeepSeek" },
    mini,
  ]

  it("keeps SiraGPT Mini through generate payload and brand label", () => {
    const resolved = resolveCatalogModel(mini.name, catalog, "DeepSeek")
    assert.equal(resolved.name, "sira-gpt-mini")
    assert.equal(resolved.provider, "Custom")
    assert.equal(resolved.replaced, false)

    const payloadModel = clampDeepSeekModel(resolved.name)
    assert.equal(payloadModel, "sira-gpt-mini")
    assert.notEqual(payloadModel, "deepseek-v4-flash")

    assert.equal(brandModelLabel(mini), "SiraGPT Mini")
    assert.notEqual(brandModelLabel(mini), SIRA_RAPIDO_LABEL)
  })

  it("keeps Mini on an empty catalog snapshot and routes it as Custom", () => {
    const resolved = resolveCatalogModel(mini.name, [], "DeepSeek")
    assert.equal(resolved.name, "sira-gpt-mini")
    assert.equal(resolved.provider, "Custom")
    assert.equal(resolved.replaced, false)
    assert.equal(clampDeepSeekModel(resolved.name), "sira-gpt-mini")
  })

  it("keeps Grok 4.5 on xAI even if the leftover provider is DeepSeek", () => {
    const grok = { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "OpenRouter" }
    const resolved = resolveCatalogModel(grok.name, [grok], "DeepSeek")
    assert.equal(resolved.name, "x-ai/grok-4.5")
    assert.equal(resolved.provider, "xAI")
    assert.equal(clampDeepSeekModel(resolved.name), "x-ai/grok-4.5")
    assert.equal(brandModelLabel(grok), "Grok 4.5")
    assert.equal(
      resolveReplyBadgeLabel({
        model: grok,
        generationUsage: { model: grok.name },
      }, [grok]),
      "Grok 4.5",
    )
    assert.notEqual(
      resolveReplyBadgeLabel({ generationUsage: { model: grok.name } }, [grok]),
      SIRA_RAPIDO_LABEL,
    )
  })

  it("does not fall back to Sira Rápido when a valid selection exists", () => {
    const resolved = resolveCatalogModel("sira-gpt-mini", catalog, "DeepSeek")
    assert.equal(resolved.replaced, false)
    assert.notEqual(brandModelLabel({ name: resolved.name, displayName: "SiraGPT Mini" }), SIRA_RAPIDO_LABEL)
    assert.notEqual(clampDeepSeekModel(resolved.name), "deepseek-v4-flash")
  })
})
