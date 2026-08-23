import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  SIRA_PRO_LABEL,
  SIRA_RAPIDO_LABEL,
  brandModelLabel,
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

  it("never returns a raw DeepSeek or OpenAI model id", () => {
    assert.equal(brandModelLabel("gpt-4o"), SIRA_RAPIDO_LABEL)
    assert.equal(brandModelLabel("openai/gpt-5"), SIRA_RAPIDO_LABEL)
    assert.equal(looksLikeRawVendorModelId("Deepseek V4 PRO"), true)
    assert.equal(looksLikeRawVendorModelId(SIRA_PRO_LABEL), false)
  })
})
