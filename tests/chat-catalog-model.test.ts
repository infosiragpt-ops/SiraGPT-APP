import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveCatalogModel } from "../lib/chat/catalog-model"

describe("chat catalog model", () => {
  it("keeps a selected model that is still in the active catalog", () => {
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
})
