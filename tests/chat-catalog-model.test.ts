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

  it("replaces a non-DeepSeek selection with Flash (fail-closed)", () => {
    assert.deepEqual(
      resolveCatalogModel("gpt-4o-mini", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "gpt-4o-mini", provider: "OpenAI" },
      ], "DeepSeek"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })

  it("falls back to Flash when the selection is invalid for this chat type", () => {
    assert.deepEqual(
      resolveCatalogModel("veo-3", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "gpt-4o-mini", provider: "OpenAI" },
      ], "Fal"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })

  it("never returns OpenRouter even if that is the only catalog row", () => {
    assert.deepEqual(
      resolveCatalogModel("moonshotai/kimi-k2.6", [
        { name: "moonshotai/kimi-k2.6", provider: "OpenRouter" },
      ], "OpenRouter"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })
})
