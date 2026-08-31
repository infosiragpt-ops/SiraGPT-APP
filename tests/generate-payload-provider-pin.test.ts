import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveCatalogModel } from "../lib/chat/catalog-model"
import { lockGeneratePayload, withLockedGenerateModel } from "../lib/chat/generate-payload"
import { clampDeepSeekModel } from "../lib/sse-client"

describe("generate payload keeps the selected catalog model", () => {
  const catalog = [
    { name: "sira-mini", displayName: "SiraGPT Mini", provider: "Custom" },
    { name: "google/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", provider: "Gemini" },
    { name: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", provider: "Anthropic" },
    { name: "anthropic/claude-fable-5", displayName: "Claude Fable 5", provider: "Anthropic" },
    { name: "gpt-5.6-terra", displayName: "GPT 5.6 Terra", provider: "OpenAI" },
    { name: "moonshotai/kimi-k2.6", displayName: "Kimi K2.6", provider: "Kimi" },
    { name: "moonshotai/kimi-k2.7-code", displayName: "MoonshotAI Kimi K2.7 Code", provider: "Kimi" },
    { name: "x-ai/grok-4.5", displayName: "Grok 4.5", provider: "xAI" },
    { name: "deepseek-v4-flash", displayName: "Sira Rápido", provider: "DeepSeek" },
    { name: "deepseek-v4-pro", displayName: "Sira Pro", provider: "DeepSeek" },
  ]

  const cases = [
    { name: "sira-mini", provider: "Custom" },
    { name: "google/gemini-3.5-flash", provider: "Gemini" },
    { name: "anthropic/claude-sonnet-5", provider: "Anthropic" },
    { name: "anthropic/claude-fable-5", provider: "Anthropic" },
    { name: "gpt-5.6-terra", provider: "OpenAI" },
    { name: "moonshotai/kimi-k2.6", provider: "Kimi" },
    { name: "moonshotai/kimi-k2.7-code", provider: "Kimi" },
    { name: "x-ai/grok-4.5", provider: "xAI" },
  ]

  for (const row of cases) {
    it(`keeps ${row.name} on ${row.provider}`, () => {
      const resolved = resolveCatalogModel(row.name, catalog, "OpenRouter")
      assert.equal(resolved.name, row.name)
      assert.equal(resolved.provider, row.provider)
      assert.equal(resolved.replaced, false)
      const payloadModel = clampDeepSeekModel(resolved.name, catalog.map((item) => item.name))
      assert.equal(payloadModel, row.name)
      assert.notEqual(payloadModel, "deepseek-v4-flash")
      assert.notEqual(resolved.provider, "OpenRouter")
      assert.notEqual(resolved.provider, "DeepSeek")
    })
  }

  it("clamps leftover openrouter/gpt-4o only when it is not in the live catalog", () => {
    assert.equal(clampDeepSeekModel("openrouter/gpt-4o", catalog.map((item) => item.name)), "deepseek-v4-flash")
    assert.equal(
      clampDeepSeekModel("openrouter/gpt-4o", ["openrouter/gpt-4o", ...catalog.map((item) => item.name)]),
      "openrouter/gpt-4o",
    )
  })

  it("empty catalog snapshot still routes GPT 5.6 Terra to OpenAI", () => {
    const locked = lockGeneratePayload("gpt-5.6-terra", "DeepSeek")
    assert.equal(locked.model, "gpt-5.6-terra")
    assert.equal(locked.provider, "OpenAI")
  })

  it("does not overwrite a Grok generate body with DeepSeek", () => {
    const body = withLockedGenerateModel({
      prompt: "hola",
      model: "x-ai/grok-4.5",
      provider: "DeepSeek",
    })
    assert.equal(body.model, "x-ai/grok-4.5")
    assert.equal(body.provider, "xAI")
  })

  it("leftover gpt-5 without catalog becomes Flash on DeepSeek", () => {
    const locked = lockGeneratePayload("gpt-5", "OpenAI")
    assert.equal(locked.model, "deepseek-v4-flash")
    assert.equal(locked.provider, "DeepSeek")
  })
})
