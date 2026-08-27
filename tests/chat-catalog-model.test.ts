import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveCatalogModel } from "../lib/chat/catalog-model"

describe("chat catalog model", () => {
  it("keeps Flash when it is the selected generation model", () => {
    assert.deepEqual(
      resolveCatalogModel("deepseek-v4-flash", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "gpt-4o-mini", provider: "OpenAI" },
      ], "DeepSeek"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: false },
    )
  })

  it("honors a non-DeepSeek selection instead of rewriting it to Flash", () => {
    assert.deepEqual(
      resolveCatalogModel("gpt-4o-mini", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "gpt-4o-mini", provider: "OpenAI" },
      ], "DeepSeek"),
      { name: "gpt-4o-mini", provider: "OpenAI", replaced: false },
    )
  })

  it("falls back to the first catalog model when the selection is invalid for this chat type", () => {
    assert.deepEqual(
      resolveCatalogModel("veo-3", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "gpt-4o-mini", provider: "OpenAI" },
      ], "Fal"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })

  it("keeps an OpenRouter pick even if that is the only catalog row", () => {
    assert.deepEqual(
      resolveCatalogModel("moonshotai/kimi-k2.6", [
        { name: "moonshotai/kimi-k2.6", provider: "OpenRouter" },
      ], "OpenRouter"),
      { name: "moonshotai/kimi-k2.6", provider: "OpenRouter", replaced: false },
    )
  })

  it("does not rewrite the generate path when the live catalog snapshot is empty", () => {
    assert.deepEqual(
      resolveCatalogModel("openai/gpt-5.5", [], "OpenRouter"),
      { name: "openai/gpt-5.5", provider: "OpenRouter", replaced: false },
    )
  })
})
