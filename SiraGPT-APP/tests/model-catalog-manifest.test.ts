import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const manifest = require(path.join(
  process.cwd(),
  "backend/src/services/model-catalog-manifest.js",
))
const modelRouter = require(path.join(
  process.cwd(),
  "backend/src/services/ai-product-os/model-router.js",
))

describe("model catalog manifest", () => {
  it("exposes DeepSeek V4 Flash and Pro as static catalog models", () => {
    const models = manifest.listManifestModels({ provider: "DeepSeek" })
    const names = models.map((model: any) => model.name)

    assert.ok(names.includes("deepseek-v4-flash"))
    assert.ok(names.includes("deepseek-v4-pro"))
    assert.equal(models.every((model: any) => model.provider === "DeepSeek"), true)
    assert.equal(models.every((model: any) => model.syncSource === "static_manifest"), true)

    const flash = models.find((model: any) => model.name === "deepseek-v4-flash")
    assert.equal(flash.contextLength, 1_000_000)
    assert.equal(flash.maxTokens, 384_000)
    assert.equal(flash.compat.supportsReasoningEffort, true)
  })

  it("merges live API models with manifest models without duplicating IDs", () => {
    const merged = manifest.mergeProviderModels(
      [
        {
          id: "deepseek-v4-pro",
          name: "deepseek-v4-pro",
          displayName: "DeepSeek V4 Pro Live",
          provider: "DeepSeek",
          type: "TEXT",
          description: "Live provider description",
          contextLength: 256000,
          tags: ["live"],
        },
      ],
      "DeepSeek",
    )
    const names = merged.map((model: any) => model.name)

    assert.equal(names.filter((name: string) => name === "deepseek-v4-pro").length, 1)
    assert.ok(names.includes("deepseek-v4-flash"))

    const pro = merged.find((model: any) => model.name === "deepseek-v4-pro")
    assert.equal(pro.displayName, "DeepSeek V4 Pro Live")
    assert.equal(pro.contextLength, 256000)
    assert.equal(pro.syncSource, "api_catalog_merge")
    assert.ok(pro.tags.includes("live"))
    assert.ok(pro.tags.includes("deepseek"))
  })

  it("returns provider catalog diagnostics for admin surfaces", () => {
    const diagnostics = manifest.getProviderCatalogDiagnostics()
    const providers = diagnostics.map((provider: any) => provider.provider)

    for (const expected of ["OpenAI", "Gemini", "OpenRouter", "DeepSeek"]) {
      assert.ok(providers.includes(expected), `missing provider ${expected}`)
    }
    assert.equal(diagnostics.every((provider: any) => provider.supportsModelCatalog), true)
    assert.equal(diagnostics.every((provider: any) => provider.staticModelCount > 0), true)
  })
})

describe("model router catalog integration", () => {
  it("makes DeepSeek V4 Flash selectable for fast low-cost tasks", () => {
    const model = modelRouter.getModel("deepseek-v4-flash")

    assert.ok(model)
    assert.equal(model.latency_tier, "fast")
    assert.equal(model.cost_tier, "low")
    assert.equal(model.context_window, 1_000_000)
    assert.equal(model.max_output, 384_000)
    assert.ok(model.plans.includes("FREE"))
  })
})
