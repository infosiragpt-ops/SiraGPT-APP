import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEEPSEEK_FLASH_LABEL,
  DEEPSEEK_PRO_LABEL,
  brandModelLabel,
  brandProviderLabel,
  looksLikeRawVendorModelId,
  prettifyDeepSeekModelId,
} from "../lib/chat/brand-label"

describe("chat brand model labels", () => {
  it("shows DeepSeek V4 Pro with its original name", () => {
    assert.equal(DEEPSEEK_PRO_LABEL, "DeepSeek V4 Pro")
    assert.equal(brandModelLabel("Deepseek V4 PRO"), DEEPSEEK_PRO_LABEL)
    assert.equal(brandModelLabel("deepseek-v4-pro"), DEEPSEEK_PRO_LABEL)
    assert.equal(brandModelLabel({ name: "DeepSeek V4 Pro Live", provider: "deepseek" }), DEEPSEEK_PRO_LABEL)
    assert.equal(brandModelLabel({ name: "deepseek/deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }), DEEPSEEK_PRO_LABEL)
  })

  it("shows DeepSeek V4 Flash with its original name", () => {
    assert.equal(DEEPSEEK_FLASH_LABEL, "DeepSeek V4 Flash")
    assert.equal(brandModelLabel("Deepseek V4 Flash"), DEEPSEEK_FLASH_LABEL)
    assert.equal(brandModelLabel("deepseek-v4-flash"), DEEPSEEK_FLASH_LABEL)
  })

  it("still accepts the legacy Sira aliases as input but never displays them", () => {
    // Saved picks, stale catalog rows and older message metadata may carry them.
    assert.equal(brandModelLabel("Sira Rápido"), DEEPSEEK_FLASH_LABEL)
    assert.equal(brandModelLabel("sira-rapido"), DEEPSEEK_FLASH_LABEL)
    assert.equal(brandModelLabel("Sira Pro"), DEEPSEEK_PRO_LABEL)
    assert.equal(brandModelLabel({ name: "deepseek-v4-flash", displayName: "Sira Rápido" }), DEEPSEEK_FLASH_LABEL)
    assert.equal(brandModelLabel({ name: "deepseek/deepseek-v4-pro", displayName: "Sira Pro" }), DEEPSEEK_PRO_LABEL)
    // Look-alikes of the legacy aliases are not the DeepSeek pair.
    assert.equal(brandModelLabel({ name: "sira-projects-bot", displayName: "Sira Proactive" }), "Sira Proactive")
  })

  it("never leaks a raw DeepSeek id", () => {
    for (const raw of ["deepseek-v4-flash", "deepseek/deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]) {
      assert.doesNotMatch(brandModelLabel(raw), /deepseek[-_/:]/i, raw)
    }
    assert.equal(brandModelLabel("deepseek-chat"), "DeepSeek Chat")
    assert.equal(brandModelLabel({ name: "deepseek-reasoner", displayName: "DeepSeek Reasoner" }), "DeepSeek Reasoner")
    assert.equal(prettifyDeepSeekModelId("deepseek/deepseek-v3.2-exp"), "DeepSeek V3.2 Exp")
    assert.equal(prettifyDeepSeekModelId("gpt-4o"), "")
  })

  it("keeps non-DeepSeek catalog labels so users can tell models apart", () => {
    assert.equal(brandModelLabel({ name: "openai/gpt-5.5", displayName: "GPT 5.5" }), "GPT 5.5")
    assert.equal(brandModelLabel("gpt-4o"), "gpt-4o")
    assert.equal(looksLikeRawVendorModelId("deepseek-v4-pro"), true)
    assert.equal(looksLikeRawVendorModelId(DEEPSEEK_PRO_LABEL), false)
    assert.equal(looksLikeRawVendorModelId(DEEPSEEK_FLASH_LABEL), false)
  })

  it("keeps SiraGPT Mini even when the raw id is local/custom", () => {
    assert.equal(brandModelLabel({ name: "moondream", displayName: "SiraGPT Mini", provider: "Ollama" }), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "sira-gpt-mini", displayName: "SiraGPT Mini", provider: "Custom" }), "SiraGPT Mini")
    assert.equal(brandModelLabel("SiraGPT Mini"), "SiraGPT Mini")
    assert.equal(brandModelLabel("sira-mini"), "SiraGPT Mini")
    assert.equal(brandModelLabel("moondream"), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "moondream" }), "SiraGPT Mini")
    assert.equal(brandModelLabel("gemma4"), "SiraGPT Mini")
    assert.equal(brandModelLabel("gemma4:26b"), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "gemma4:26b" }), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "gemma4:26b", displayName: "Gemma 4" }), "SiraGPT Mini")
    assert.notEqual(brandModelLabel({ name: "moondream", displayName: "SiraGPT Mini" }), DEEPSEEK_FLASH_LABEL)
    assert.doesNotMatch(brandModelLabel({ name: "moondream" }), /moondream|Ollama|HuggingFace|DeepSeek|gemma4/i)
    assert.doesNotMatch(brandModelLabel({ name: "gemma4:26b" }), /gemma4|Ollama|DeepSeek/i)
  })

  it("shows DeepSeek as the provider heading and hides local vendors", () => {
    assert.equal(brandProviderLabel("DeepSeek"), "DeepSeek")
    assert.equal(brandProviderLabel("deepseek"), "DeepSeek")
    assert.equal(brandProviderLabel({ name: "deepseek-v4-flash", provider: "DeepSeek" }), "DeepSeek")
    assert.equal(brandProviderLabel("Sira Rápido"), "DeepSeek")
    assert.equal(brandProviderLabel("Ollama"), "Sira")
    assert.equal(brandProviderLabel("HuggingFace"), "Sira")
    assert.equal(brandProviderLabel("OpenAI"), "OpenAI")
    assert.equal(brandProviderLabel("Anthropic"), "Anthropic")
  })
})
