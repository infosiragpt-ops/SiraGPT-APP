import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const globalsPath = path.join(process.cwd(), "app", "globals.css")
const globals = fs.readFileSync(globalsPath, "utf8")

describe("professional chat composer surface source contract", () => {
  it("uses one calm static focus treatment instead of the animated double ring", () => {
    assert.match(
      globals,
      /\.composer-surface:focus-within\s*\{[\s\S]{0,320}0 0 0 3px hsl\(var\(--accent-violet\) \/ 0\.08\)/,
      "the composer should keep a visible but restrained keyboard focus ring"
    )
    assert.match(
      globals,
      /\.composer-focus-glow::before\s*\{\s*content: none;\s*display: none;/,
      "the old animated conic focus ring should stay disabled"
    )
    assert.match(
      globals,
      /\.composer-surface\.composer-liquid-surface::before\s*\{\s*content: none;\s*display: none !important;/,
      "the glare removal should stay scoped to chat composers"
    )
  })

  it("keeps all primary composer controls at accessible stable dimensions", () => {
    assert.match(
      globals,
      /\.composer-input-row \.composer-toolbar-actions > button\s*\{[\s\S]{0,240}width: 2\.75rem !important;[\s\S]{0,160}height: 2\.75rem !important;/,
      "send, stop and dictation controls should keep a 44px target"
    )
    assert.match(
      globals,
      /\.composer-plus-liquid-button\s*\{[\s\S]{0,220}width: 2\.75rem !important;[\s\S]{0,160}height: 2\.75rem !important;/,
      "the attachment control should align with the other 44px actions"
    )
  })

  it("uses the compact professional rhythm on desktop and mobile", () => {
    assert.match(
      globals,
      /\.composer-input-row\s*\{[\s\S]{0,420}min-height: 5\.5rem;[\s\S]{0,100}padding: 0\.625rem 0\.75rem 0\.5rem !important;/,
      "the idle composer should not reserve oversized vertical space"
    )
    assert.match(
      globals,
      /@media \(max-width: 640px\)[\s\S]{0,320}\.composer-surface\s*\{\s*border-radius: 1\.5rem;[\s\S]{0,180}min-height: 5\.5rem;/,
      "phones should keep the same compact hierarchy without oversized rounding"
    )
  })
})
