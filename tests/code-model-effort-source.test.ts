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
    assert.match(source, /role="group" aria-label="Profundidad de razonamiento"/)
    assert.match(source, /aria-pressed=\{index === effortIndex\}/)
    assert.doesNotMatch(source, /className="model-picker-effort-slider"/)
    assert.match(
      source,
      /reasoningEffort:\s*selectedEffort/,
      "code chat streams must forward the selected effort to /ai/generate",
    )
    assert.match(
      source,
      /codexApi\.createRun[\s\S]{0,900}reasoningEffort:\s*resolveCodexReasoningEffort\(selectedEffort\)/,
      "durable Codex plan runs must persist the selected effort",
    )
    assert.match(
      source,
      /codexApi\.approvePlan[\s\S]{0,500}model:\s*activeModelName[\s\S]{0,250}reasoningEffort:\s*resolveCodexReasoningEffort\(selectedEffort\)/,
      "plan continuations must preserve exact model and effort",
    )
    assert.match(
      source,
      /selectedEffort=\{selectedEffort\}[\s\S]*onSelectEffort=\{setSelectedEffort\}/,
      "ModelPickerInline must receive the effort state from the code chat panel",
    )
  })

  it("cancels a build created after a delayed plan approval", () => {
    assert.match(
      source,
      /const buildRun = await codexApi\.approvePlan[\s\S]{0,900}if \(cancelledTurn\(\)\)[\s\S]{0,900}runId: buildRun\.id[\s\S]{0,500}beginCodexCancellation\(assistantId, target\)[\s\S]{0,200}requestCodexCancellation\(target, attempt\)/,
    )
  })
})
