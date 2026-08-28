import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  SIRA_PRO_LABEL,
  SIRA_RAPIDO_LABEL,
  brandModelLabel,
  brandProviderLabel,
  looksLikeRawVendorModelId,
} from "../lib/chat/brand-label"

describe("chat brand model labels", () => {
  it("maps DeepSeek V4 Pro aliases to Sira Pro", () => {
    assert.equal(brandModelLabel("Deepseek V4 PRO"), SIRA_PRO_LABEL)
    assert.equal(brandModelLabel("deepseek-v4-pro"), SIRA_PRO_LABEL)
    assert.equal(brandModelLabel({ name: "DeepSeek V4 Pro Live", provider: "deepseek" }), SIRA_PRO_LABEL)
  })

  it("maps DeepSeek V4 Flash aliases to Sira Rápido", () => {
    assert.equal(brandModelLabel("Deepseek V4 Flash"), SIRA_RAPIDO_LABEL)
    assert.equal(brandModelLabel("deepseek-v4-flash"), SIRA_RAPIDO_LABEL)
  })

  it("keeps non-DeepSeek catalog labels so users can tell models apart", () => {
    assert.equal(brandModelLabel({ name: "openai/gpt-5.5", displayName: "GPT 5.5" }), "GPT 5.5")
    assert.equal(brandModelLabel("gpt-4o"), "gpt-4o")
    assert.equal(looksLikeRawVendorModelId("Deepseek V4 PRO"), true)
    assert.equal(looksLikeRawVendorModelId(SIRA_PRO_LABEL), false)
  })

  it("keeps SiraGPT Mini even when the raw id is local/custom", () => {
    assert.equal(brandModelLabel({ name: "moondream", displayName: "SiraGPT Mini", provider: "Ollama" }), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "sira-gpt-mini", displayName: "SiraGPT Mini", provider: "Custom" }), "SiraGPT Mini")
    assert.equal(brandModelLabel("SiraGPT Mini"), "SiraGPT Mini")
    assert.equal(brandModelLabel("sira-mini"), "SiraGPT Mini")
    assert.equal(brandModelLabel("moondream"), "SiraGPT Mini")
    assert.equal(brandModelLabel({ name: "moondream" }), "SiraGPT Mini")
    assert.notEqual(brandModelLabel({ name: "moondream", displayName: "SiraGPT Mini" }), SIRA_RAPIDO_LABEL)
    assert.doesNotMatch(brandModelLabel({ name: "moondream" }), /moondream|Ollama|HuggingFace|DeepSeek/i)
  })

  it("maps DeepSeek provider headings to Sira and leaves other vendors intact", () => {
    assert.equal(brandProviderLabel("DeepSeek"), "Sira")
    assert.equal(brandProviderLabel("Ollama"), "Sira")
    assert.equal(brandProviderLabel("HuggingFace"), "Sira")
    assert.equal(brandProviderLabel("fal.ai"), "Sira")
    assert.equal(brandProviderLabel("OpenRouter"), "Sira")
    assert.equal(brandProviderLabel("moondream"), "Sira")
    assert.equal(brandProviderLabel("OpenAI"), "OpenAI")
    assert.equal(brandProviderLabel("Anthropic"), "Anthropic")
  })
})
