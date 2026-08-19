import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const preview = readFileSync("components/code/preview-pane.tsx", "utf8")
const styles = readFileSync("app/globals.css", "utf8")

describe("professional visual inspector source contract", () => {
  it("exposes an explicit labelled selector with honest active and captured states", () => {
    assert.match(chat, /data-testid="code-target-selector"/)
    assert.match(chat, /Seleccionar UI/)
    assert.match(chat, /Cancelar inspector visual/)
    assert.match(chat, /aria-pressed=\{selectingTarget\}/)
    assert.match(chat, /data-testid="code-target-selection-chip"/)
    assert.match(chat, /Elemento seleccionado/)
    assert.doesNotMatch(chat, /function CodeTargetSelectIcon/)
  })

  it("keeps a cancellable inspector toolbar and a keyboard escape route over the preview", () => {
    assert.match(preview, /data-testid="code-preview-inspector-toolbar"/)
    assert.match(preview, /Inspector visual activo/)
    assert.match(preview, /aria-label="Cancelar inspector visual"/)
    assert.match(preview, /window\.addEventListener\("keydown", onKeyDown, \{ capture: true \}\)/)
    assert.match(preview, /event\.key !== "Escape"/)
    assert.match(preview, /postSelectionMessage\("sgpt-preview-select-cancel"\)/)
    assert.match(preview, /if \(!selectionModeRef\.current\) return/)
  })

  it("uses accessible segmented effort controls and touch targets", () => {
    assert.match(styles, /\.model-picker-effort-options\s*\{[\s\S]{0,220}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
    assert.match(styles, /\.model-picker-effort-option\s*\{[\s\S]{0,180}min-height: 2\.375rem/)
    assert.match(styles, /@media \(pointer: coarse\)[\s\S]{0,160}\.model-picker-effort-option\s*\{\s*min-height: 2\.75rem/)
    assert.match(styles, /\.code-target-select-button\s*\{[\s\S]{0,220}min-height: 2rem/)
  })
})
