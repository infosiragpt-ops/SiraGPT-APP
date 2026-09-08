import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { clampDeepSeekModel, isFirstPartyCatalogModel } from "../lib/sse-client"

describe("clampDeepSeekModel", () => {
  it("canonicalizes DeepSeek Flash/Pro aliases", () => {
    assert.equal(clampDeepSeekModel("deepseek-v4-flash"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("deepseek/deepseek-v4-pro"), "deepseek-v4-pro")
  })

  it("still remaps leftover OpenRouter / obsolete ids that are not in the live catalog", () => {
    assert.equal(clampDeepSeekModel("openrouter/gpt-4o"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("openai/gpt-4o"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("gpt-4o-mini"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("gpt-5"), "deepseek-v4-flash")
    assert.equal(clampDeepSeekModel("o4-mini"), "deepseek-v4-flash")
  })

  it("does not remap leftover ids that are present in the live catalog", () => {
    assert.equal(clampDeepSeekModel("gpt-4o", ["gpt-4o", "google/gemini-3.5-flash"]), "gpt-4o")
    assert.equal(clampDeepSeekModel("openrouter/gpt-4o", ["openrouter/gpt-4o"]), "openrouter/gpt-4o")
  })

  it("passes through user-selected Gemini / Claude / GPT / Kimi / Mini", () => {
    assert.equal(clampDeepSeekModel("sira-gpt-mini"), "sira-gpt-mini")
    assert.equal(clampDeepSeekModel("SiraGPT Mini"), "SiraGPT Mini")
    assert.equal(clampDeepSeekModel("sira-mini"), "sira-mini")
    assert.equal(clampDeepSeekModel("google/gemini-3.5-flash"), "google/gemini-3.5-flash")
    assert.equal(clampDeepSeekModel("gemini-3.5-flash"), "gemini-3.5-flash")
    assert.equal(clampDeepSeekModel("anthropic/claude-sonnet-5"), "anthropic/claude-sonnet-5")
    assert.equal(clampDeepSeekModel("claude-fable-5"), "claude-fable-5")
    assert.equal(clampDeepSeekModel("gpt-5.6-terra"), "gpt-5.6-terra")
    assert.equal(clampDeepSeekModel("openai/gpt-5.6-terra"), "openai/gpt-5.6-terra")
    assert.equal(clampDeepSeekModel("moonshotai/kimi-k2.6"), "moonshotai/kimi-k2.6")
    assert.equal(clampDeepSeekModel("moonshotai/kimi-k2.7-code"), "moonshotai/kimi-k2.7-code")
    assert.notEqual(clampDeepSeekModel("sira-gpt-mini"), "deepseek-v4-flash")
    assert.notEqual(clampDeepSeekModel("gpt-5.6-terra"), "deepseek-v4-flash")
  })

  it("marks first-party catalog families so generate can keep their provider", () => {
    assert.equal(isFirstPartyCatalogModel("google/gemini-3.5-flash"), true)
    assert.equal(isFirstPartyCatalogModel("anthropic/claude-fable-5"), true)
    assert.equal(isFirstPartyCatalogModel("gpt-5.6-terra"), true)
    assert.equal(isFirstPartyCatalogModel("moonshotai/kimi-k2.6"), true)
    assert.equal(isFirstPartyCatalogModel("sira-mini"), true)
    assert.equal(isFirstPartyCatalogModel("openrouter/gpt-4o"), false)
    assert.equal(isFirstPartyCatalogModel("gpt-4o"), false)
  })
})
