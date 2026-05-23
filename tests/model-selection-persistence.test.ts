import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  loadPersistedModelSelection,
  savePersistedModelSelection,
  pickModelFromCatalog,
} from "../lib/model-selection-persistence"

describe("model-selection-persistence", () => {
  it("pickModelFromCatalog prefers persisted model when available", () => {
    const models = [
      { name: "gema4-31b", provider: "Gemini" },
      { name: "gpt-5", provider: "OpenAI" },
    ]
    const picked = pickModelFromCatalog(models, { model: "gpt-5", provider: "OpenAI", updatedAt: 1 })
    assert.deepEqual(picked, { model: "gpt-5", provider: "OpenAI" })
  })

  it("pickModelFromCatalog falls back to first model when persisted is missing", () => {
    const models = [{ name: "gema4-31b", provider: "Gemini" }]
    const picked = pickModelFromCatalog(models, { model: "gpt-5", provider: "OpenAI", updatedAt: 1 })
    assert.deepEqual(picked, { model: "gema4-31b", provider: "Gemini" })
  })

  it("loadPersistedModelSelection returns null without window", () => {
    assert.equal(loadPersistedModelSelection(), null)
  })

  it("savePersistedModelSelection is a no-op without window", () => {
    assert.doesNotThrow(() => savePersistedModelSelection("gpt-5", "OpenAI"))
  })
})
