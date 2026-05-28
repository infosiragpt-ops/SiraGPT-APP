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
  it("exposes only the requested public model list in order", () => {
    const models = curateVisibleTextModels([
      { id: "old", name: "gpt-4o", displayName: "GPT-4o", provider: "OpenAI", type: "TEXT" },
      { id: "kimi-db", name: "moonshotai/kimi-k2.6", displayName: "Kimi old", provider: "OpenRouter", type: "TEXT" },
    ])

    assert.deepEqual(
      models.map((model: any) => model.displayName),
      ["GPT 5.5", "Opus 4.7", "Gemini 3.5", "Grok 4.2", "Kimi K2.6", "Z5.1", "Deepseek V4 PRO", "Gema 4"],
    )
    assert.deepEqual(
      models.map((model: any) => model.name),
      [
        "openai/gpt-5.5",
        "anthropic/claude-opus-4.7",
        "google/gemini-3.5",
        "x-ai/grok-4.2",
        "moonshotai/kimi-k2.6",
        "z-ai/glm-5.1",
        "deepseek/deepseek-v4-pro",
        "Gema4-31B",
      ],
    )
  })

  it("marks every visible model as FREE-eligible in the router catalog", () => {
    const visible = curateVisibleTextModels()
    for (const model of visible) {
      const catalogEntry = modelRouter.getModel(model.name)
      assert.ok(catalogEntry, `missing router catalog entry for ${model.name}`)
      assert.ok(catalogEntry.plans.includes("FREE"), `${model.name} must be FREE eligible`)
    }
  })
})
