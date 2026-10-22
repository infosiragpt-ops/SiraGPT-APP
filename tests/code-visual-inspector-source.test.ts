import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
const styles = readFileSync("app/globals.css", "utf8")

describe("professional visual inspector source contract", () => {

  it("uses accessible segmented effort controls and touch targets", () => {
    assert.match(styles, /\.model-picker-effort-options\s*\{[\s\S]{0,220}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)
    assert.match(styles, /\.model-picker-effort-option\s*\{[\s\S]{0,180}min-height: 2\.375rem/)
    assert.match(styles, /@media \(pointer: coarse\)[\s\S]{0,160}\.model-picker-effort-option\s*\{\s*min-height: 2\.75rem/)
    assert.match(styles, /\.code-target-select-button\s*\{[\s\S]{0,220}min-height: 2rem/)
  })
})
