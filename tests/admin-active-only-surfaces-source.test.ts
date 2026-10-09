import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chatContext = readFileSync("lib/chat-context-integrated.tsx", "utf8")
const chatInterface = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const codePanel = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const designComposer = readFileSync("components/design/design-composer.tsx", "utf8")

describe("admin-active model surfaces", () => {
  it("preserves the user's unavailable selection but blocks sends instead of silently switching models", () => {
    assert.match(chatContext, /isActiveCatalogSelection\(selectedModel, availableModels\)/)
    assert.match(chatContext, /[Ee]l modelo (?:elegido|seleccionado)[\s\S]{0,160}(?:disponible|activo)/)
    assert.match(chatContext, /reconcileSelectedCatalogModel\(activeModels, selectedModelRef\.current, selectProvider\)/)
    assert.match(chatContext, /reconcileSelectedCatalogModel\(availableModels, name\)/)
    assert.match(chatContext, /setSelectedModel\(preferred\?\.name \|\| ""\)/)
    assert.match(chatInterface, /No se pudo guardar el modelo\. Se restauró la selección anterior/)
  })

  it("does not manufacture code or design fallbacks when the catalog is empty", () => {
    assert.doesNotMatch(codePanel, /policy\?\.fallbackModel/)
    assert.match(codePanel, /Sin modelos activos/)
    assert.doesNotMatch(designComposer, /Absolute fallback/)
    assert.doesNotMatch(designComposer, /useState<string>\(initialModel \|\| "deepseek-v4-flash"\)/)
    assert.match(designComposer, /No hay modelos activos\. Activa uno desde Administración/)
  })

  it("loads voice and music choices from the active API catalog", () => {
    assert.doesNotMatch(chatInterface, /VOICE_MODEL_OPTIONS\.map/)
    assert.doesNotMatch(chatInterface, /MUSIC_MODEL_OPTIONS\.map/)
    assert.match(chatInterface, /getAIModels\('VOICE'\)/)
    assert.match(chatInterface, /getAIModels\('MUSIC'\)/)
    assert.match(chatInterface, /model\?\.isActive === true/)
  })
})
