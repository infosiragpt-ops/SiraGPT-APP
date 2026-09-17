import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { pinGenerateRequest, resolveCatalogModel } from "../lib/chat/catalog-model"
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

  it("pins image / video / audio generate payloads to the picker id", () => {
    assert.deepEqual(
      pinGenerateRequest({ model: "x-ai/grok-4.5", provider: "Kimi", prompt: "hola" }),
      { model: "x-ai/grok-4.5", provider: "xAI", prompt: "hola" },
    )
    assert.deepEqual(
      pinGenerateRequest({ model: "anthropic/claude-sonnet-5", provider: "DeepSeek" }),
      { model: "anthropic/claude-sonnet-5", provider: "Anthropic" },
    )
    assert.notEqual(
      pinGenerateRequest({ model: "google/gemini-3.5-flash", provider: "OpenRouter" }).provider,
      "OpenRouter",
    )
    assert.deepEqual(
      pinGenerateRequest({ model: "gpt-5.6-terra", provider: "Kimi" }),
      { model: "gpt-5.6-terra", provider: "OpenAI" },
    )

    const apiSource = fs.readFileSync(path.join(process.cwd(), "lib", "api.ts"), "utf8")
    assert.match(apiSource, /pinGenerateRequest\(data\)/)
    assert.match(apiSource, /\/ai\/generate-image/)
    assert.match(apiSource, /\/ai\/generate-video/)
    assert.match(apiSource, /\/ai\/generate-speech/)
    assert.match(apiSource, /\/ai\/generate-music/)
  })

  it("does not let a leftover Kimi provider steal Claude or Grok", () => {
    assert.deepEqual(
      resolveCatalogModel("anthropic/claude-sonnet-5", catalog, "Kimi"),
      { name: "anthropic/claude-sonnet-5", provider: "Anthropic", replaced: false },
    )
    assert.deepEqual(
      resolveCatalogModel("x-ai/grok-4.5", catalog, "Kimi"),
      { name: "x-ai/grok-4.5", provider: "xAI", replaced: false },
    )
  })

  it("clamps leftover openrouter/gpt-4o only when it is not in the live catalog", () => {
    assert.equal(clampDeepSeekModel("openrouter/gpt-4o", catalog.map((item) => item.name)), "deepseek-v4-flash")
    assert.equal(
      clampDeepSeekModel("openrouter/gpt-4o", ["openrouter/gpt-4o", ...catalog.map((item) => item.name)]),
      "openrouter/gpt-4o",
    )
  })
})
