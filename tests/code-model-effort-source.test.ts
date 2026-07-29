import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

describe("code model effort selector source contract", () => {
  it("exposes Effort under the /code model picker and sends reasoningEffort", () => {
    assert.match(
      source,
      /const\s+COMPOSER_EFFORT_LEVELS\s*=\s*\[[\s\S]*value:\s*"Bajo"[\s\S]*value:\s*"Medio"[\s\S]*value:\s*"Extra"[\s\S]*value:\s*"Max"/,
      "effort levels must stay aligned with backend Bajo/Medio/Extra/Max aliases",
    )
    assert.match(
      source,
      /className="model-picker-effort"/,
      "the /code model picker must render the Effort control",
    )
    assert.match(
      source,
      /reasoningEffort:\s*selectedEffort/,
      "code chat streams must forward the selected effort to /ai/generate",
    )
    assert.match(
      source,
      /selectedEffort=\{selectedEffort\}[\s\S]*onSelectEffort=\{setSelectedEffort\}/,
      "ModelPickerInline must receive the effort state from the code chat panel",
    )
  })
})
