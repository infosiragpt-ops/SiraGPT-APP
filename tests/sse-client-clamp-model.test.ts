import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clampDeepSeekModel } from "../lib/sse-client"

describe("clampDeepSeekModel", () => {
  it("canonicalizes DeepSeek Flash/Pro aliases", () => {
    assert.equal(clampDeepSeekModel("deepseek-v4-flash"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("deepseek/deepseek-v4-pro"), "deepseek-v4-pro")
  })

  it("still remaps leftover OpenRouter/GPT vendor ids", () => {
    assert.equal(clampDeepSeekModel("openai/gpt-4o"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("gpt-4o-mini"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("gpt-5"), "deepseek-v4-flash")
  })

  it("passes through a user-selected non-Flash catalog id", () => {
    assert.equal(clampDeepSeekModel("sira-gpt-mini"), "sira-gpt-mini")
    assert.equal(clampDeepSeekModel("SiraGPT Mini"), "SiraGPT Mini")
    assert.equal(clampDeepSeekModel("moondream"), "moondream")
    assert.notEqual(clampDeepSeekModel("sira-gpt-mini"), "deepseek-v4-flash")
  })
})
