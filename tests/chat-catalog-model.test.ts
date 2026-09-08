import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isActiveCatalogSelection, pickPreferredCatalogModel, resolveCatalogModel } from "../lib/chat/catalog-model"

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

  it("maps Mini aliases including gemma4 to Custom without dumping vendor ids", () => {
    assert.deepEqual(
      resolveCatalogModel("gemma4:26b", [], "DeepSeek"),
      { name: "gemma4:26b", provider: "Custom", replaced: false },
    )
    assert.deepEqual(
      resolveCatalogModel("sira-mini", [
        { name: "sira-mini", provider: "Custom" },
        { name: "deepseek-v4-flash", provider: "DeepSeek" },
      ]),
      { name: "sira-mini", provider: "Custom", replaced: false },
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
      resolveCatalogModel("qwen/qwen-2.5-72b-instruct", [
        { name: "qwen/qwen-2.5-72b-instruct", provider: "OpenRouter" },
      ], "OpenRouter"),
      { name: "qwen/qwen-2.5-72b-instruct", provider: "OpenRouter", replaced: false },
    )
  })

  it("does not let OpenRouter steal Grok from xAI", () => {
    assert.deepEqual(
      resolveCatalogModel("x-ai/grok-4.5", [
        { name: "x-ai/grok-4.5", provider: "OpenRouter" },
      ], "DeepSeek"),
      { name: "x-ai/grok-4.5", provider: "xAI", replaced: false },
    )
  })

  it("does not rewrite the generate path when the live catalog snapshot is empty", () => {
    assert.deepEqual(
      resolveCatalogModel("openai/gpt-5.5", [], "OpenRouter"),
      { name: "openai/gpt-5.5", provider: "OpenAI", replaced: false },
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

  it("rejects stale selections and never invents a model for an empty active catalog", () => {
    const catalog = [
      { name: "muse-spark-1.2", provider: "Meta" },
      { name: "deepseek-v4-pro", provider: "DeepSeek" },
    ]

    assert.equal(isActiveCatalogSelection("muse-spark-1.2", catalog), true)
    assert.equal(isActiveCatalogSelection("disabled-model", catalog), false)
    assert.equal(isActiveCatalogSelection("muse-spark-1.2", []), false)
    assert.deepEqual(
      pickPreferredCatalogModel(catalog, { current: "disabled-model", pinned: "deepseek-v4-pro" }),
      { name: "deepseek-v4-pro", provider: "DeepSeek" },
    )
    assert.equal(pickPreferredCatalogModel([], { current: "disabled-model" }), null)
  })
})
