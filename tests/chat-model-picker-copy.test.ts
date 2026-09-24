import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { brandModelLabel } from "../lib/chat/brand-label"
import { getModelTagline } from "../lib/chat/model-tagline"
import {
  composerEffortLabel,
  migrateStoredComposerEffort,
  modelSupportsComposerEffort,
  normalizeComposerEffort,
} from "../lib/chat/composer-effort"

describe("composer model picker copy", () => {
  it("cleans OpenRouter catalog labels without touching product names", () => {
    assert.equal(brandModelLabel({ displayName: "Dots Studio: Dots3-Note Preview (free)", name: "x" }), "Dots3-Note Preview")
    assert.equal(brandModelLabel({ displayName: "Grok 4.6", name: "x-ai/grok-4.6" }), "Grok 4.6")
    assert.equal(brandModelLabel({ displayName: "Sira Pro", name: "deepseek/deepseek-v4-pro" }), "Sira Pro")
    assert.equal(brandModelLabel({ name: "deepseek-v4-flash" }), "Sira Rápido")
  })

  it("gives every model a short Spanish tagline", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ displayName: "Claude Fable 5.1", provider: "Anthropic" }, "Para tus desafíos más difíciles"],
      [{ displayName: "Sira Pro", name: "deepseek/deepseek-v4-pro" }, "Razonamiento para trabajo complejo"],
      [{ displayName: "Sira Rápido", name: "deepseek/deepseek-v4-flash" }, "Rápido para las tareas del día a día"],
      [{ displayName: "Gemini 3.8 Flash", provider: "Gemini" }, "Rápido y multimodal"],
      [{ displayName: "TypeSafe Jev", provider: "TypeSafe" }, "Decisiones estructuradas y fiables"],
      [{ displayName: "Dots3-Note Preview", name: "dots/dots3-note:free", provider: "OpenRouter" }, "Vista previa experimental"],
    ]
    for (const [model, tagline] of cases) assert.equal(getModelTagline(model), tagline, JSON.stringify(model))
    const fallback = getModelTagline({ displayName: "Acme X", description: "Modelo de Acme para resumir contratos largos. Muy bueno." })
    assert.equal(fallback, "Resumir contratos largos")
    assert.ok(getModelTagline({ displayName: "Acme X" }).length > 0)
    for (const [model] of cases) assert.ok(getModelTagline(model).length <= 40, "taglines fit one line")
  })

  it("migrates the four-stop slider values onto the five-level scale", () => {
    assert.equal(migrateStoredComposerEffort("Extra", null), "Alto")
    assert.equal(migrateStoredComposerEffort("Max", null), "Extra")
    assert.equal(migrateStoredComposerEffort("Bajo", null), "Bajo")
    assert.equal(migrateStoredComposerEffort("Extra", "5"), "Extra")
    assert.equal(migrateStoredComposerEffort("garbage", "5"), "Medio")
    assert.equal(normalizeComposerEffort("xhigh"), "Extra")
    assert.equal(composerEffortLabel("Max"), "Máx")
  })

  it("hides the effort row for decision and media models only", () => {
    assert.equal(modelSupportsComposerEffort({ provider: "TypeSafe", displayName: "TypeSafe Jev" }), false)
    assert.equal(modelSupportsComposerEffort({ provider: "OpenAI", type: "IMAGE" }), false)
    assert.equal(modelSupportsComposerEffort({ provider: "xAI", displayName: "Grok 4.6", type: "TEXT" }), true)
    assert.equal(modelSupportsComposerEffort(undefined), true)
  })
})
