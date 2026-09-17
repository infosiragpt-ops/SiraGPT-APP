import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chatContext = readFileSync("lib/chat-context-integrated.tsx", "utf8")
const chatInterface = readFileSync("components/chat-interface-enhanced.tsx", "utf8")
const codePanel = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const designComposer = readFileSync("components/design/design-composer.tsx", "utf8")

describe("admin-active model surfaces", () => {
  it("clears stale chat selections and blocks text sends without an active row", () => {
    assert.match(chatContext, /isActiveCatalogSelection\(selectedModel, availableModels\)/)
    assert.match(chatContext, /No hay modelos activos\. Activa uno desde Administración/)
    assert.match(chatContext, /setSelectedModel\(preferred\?\.name \|\| ""\)/)
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
