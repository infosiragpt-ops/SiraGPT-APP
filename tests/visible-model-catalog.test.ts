import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const { curateVisibleTextModels } = require(path.join(
  process.cwd(),
  "backend/src/services/visible-model-catalog.js",
))
const modelRouter = require(path.join(
  process.cwd(),
  "backend/src/services/ai-product-os/model-router.js",
))

describe("visible text model catalog", () => {
  it("exposes only admin-active public models in curated order", () => {
    const models = curateVisibleTextModels([
      { id: "kimi-db", name: "moonshotai/kimi-k2.6", displayName: "Kimi old", provider: "OpenRouter", type: "TEXT", isActive: true },
      { id: "gpt-db", name: "openai/gpt-5.5", displayName: "GPT old", provider: "OpenRouter", type: "TEXT", isActive: true },
      { id: "inactive-opus", name: "anthropic/claude-opus-4.7", displayName: "Opus disabled", provider: "OpenRouter", type: "TEXT", isActive: false },
      { id: "__virtual_gemini__", name: "google/gemini-3.5", displayName: "Gemini virtual", provider: "OpenRouter", type: "TEXT" },
      { id: "old", name: "gpt-4o", displayName: "GPT-4o", provider: "OpenAI", type: "TEXT", isActive: true },
    ])

    assert.deepEqual(
      models.map((model: any) => model.displayName),
      ["GPT 5.5", "Kimi K2.6", "GPT-4o"],
    )
    assert.deepEqual(
      models.map((model: any) => model.name),
      ["openai/gpt-5.5", "moonshotai/kimi-k2.6", "gpt-4o"],
    )
    assert.deepEqual(
      models.map((model: any) => model.id),
      ["gpt-db", "kimi-db", "old"],
    )
  })

  it("does not invent virtual visible models when admin has no active row", () => {
    assert.deepEqual(curateVisibleTextModels([]), [])
  })

  it("keeps admin-enabled flagship models FREE-eligible in the router catalog", () => {
    const enabledRows = [
      "openai/gpt-5.5",
      "anthropic/claude-opus-4.7",
      "google/gemini-3.5",
      "x-ai/grok-4.2",
      "moonshotai/kimi-k2.6",
      "z-ai/glm-5.1",
      "deepseek/deepseek-v4-pro",
      "Gema4-31B",
    ].map((name) => ({
      id: `admin-${name.replace(/[^a-z0-9]+/gi, "-")}`,
      name,
      displayName: name,
      provider: "OpenRouter",
      type: "TEXT",
      isActive: true,
    }))

    const visible = curateVisibleTextModels(enabledRows)
    assert.deepEqual(visible.map((model: any) => model.name), enabledRows.map((model) => model.name))

    for (const model of visible) {
      const catalogEntry = modelRouter.getModel(model.name)
      assert.ok(catalogEntry, `missing router catalog entry for ${model.name}`)
      assert.ok(catalogEntry.plans.includes("FREE"), `${model.name} must be FREE eligible`)
    }
  })
})
