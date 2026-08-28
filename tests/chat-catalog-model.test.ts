import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { pickPreferredCatalogModel, resolveCatalogModel, isStaleNonChatCatalogSelection } from "../lib/chat/catalog-model"

const TEXT_CATALOG = [
  { name: "deepseek-v4-flash", provider: "DeepSeek" },
  { name: "SiraGPT Mini", provider: "Custom" },
]
const SEEDANCE = "bytedance/seedance-2.0/text-to-video"

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

  it("keeps a valid user pick even when it is not in the live catalog snapshot", () => {
    assert.deepEqual(
      resolveCatalogModel("sira-gpt-mini", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "deepseek-v4-pro", provider: "DeepSeek" },
      ], "DeepSeek"),
      { name: "sira-gpt-mini", provider: "Custom", replaced: false },
    )
  })

  it("does not fall back to Flash when a non-Flash selection exists", () => {
    assert.deepEqual(
      resolveCatalogModel("SiraGPT Mini", [
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
        { name: "SiraGPT Mini", provider: "Custom" },
      ], "Custom"),
      { name: "SiraGPT Mini", provider: "Custom", replaced: false },
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

  it("drops a leftover Seedance current once it left the TEXT catalog", () => {
    assert.equal(isStaleNonChatCatalogSelection(SEEDANCE, TEXT_CATALOG), true)
    assert.deepEqual(
      pickPreferredCatalogModel(TEXT_CATALOG, { current: SEEDANCE, last: "SiraGPT Mini" }),
      { name: "SiraGPT Mini", provider: "Custom" },
    )
    assert.deepEqual(
      resolveCatalogModel(SEEDANCE, TEXT_CATALOG, "fal.ai"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })

  it("does not honor a leftover Seedance id on an empty generate snapshot", () => {
    assert.deepEqual(
      resolveCatalogModel(SEEDANCE, [], "fal.ai"),
      { name: "deepseek-v4-flash", provider: "DeepSeek", replaced: true },
    )
  })

  it("keeps Seedance when the loaded catalog is actually VIDEO", () => {
    const videoCatalog = [{ name: SEEDANCE, provider: "fal.ai" }]
    assert.equal(isStaleNonChatCatalogSelection(SEEDANCE, videoCatalog), false)
    assert.deepEqual(
      pickPreferredCatalogModel(videoCatalog, { current: SEEDANCE }),
      { name: SEEDANCE, provider: "fal.ai" },
    )
  })

  it("prefers the current pick, then pinned, then last, over catalog[0]", () => {
    const catalog = [
      { name: "deepseek-v4-flash", provider: "DeepSeek" },
      { name: "sira-gpt-mini", provider: "Custom" },
      { name: "deepseek-v4-pro", provider: "DeepSeek" },
    ]
    assert.deepEqual(
      pickPreferredCatalogModel(catalog, { current: "sira-gpt-mini", pinned: "deepseek-v4-pro" }),
      { name: "sira-gpt-mini", provider: "Custom" },
    )
    assert.deepEqual(
      pickPreferredCatalogModel(catalog, { pinned: "sira-gpt-mini", last: "deepseek-v4-pro" }),
      { name: "sira-gpt-mini", provider: "Custom" },
    )
    assert.deepEqual(
      pickPreferredCatalogModel(catalog, { last: "deepseek-v4-pro" }),
      { name: "deepseek-v4-pro", provider: "DeepSeek" },
    )
  })
})
