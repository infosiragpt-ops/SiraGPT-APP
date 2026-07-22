import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const globalsPath = path.join(process.cwd(), "app", "globals.css")
const globals = fs.readFileSync(globalsPath, "utf8")
const chatInterfacePath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const chatInterface = fs.readFileSync(chatInterfacePath, "utf8")

describe("professional chat composer surface source contract", () => {
  it("uses one hairline focus treatment instead of stacked rings", () => {
    assert.match(
      globals,
      /\.composer-surface\s*\{[\s\S]{0,160}border: 0\.5px solid hsl\(220 13% 86% \/ 0\.86\)/,
      "the light composer should use a half-pixel hairline border"
    )
    assert.match(
      globals,
      /\.dark \.composer-surface\s*\{[\s\S]{0,160}border: 0\.5px solid hsl\(var\(--composer-border\) \/ 0\.88\)/,
      "the dark composer should use the same half-pixel hairline border"
    )
    assert.doesNotMatch(
      globals,
      /\.composer-surface:focus-within\s*\{[\s\S]{0,320}0 0 0 [\d.]+px/,
      "focus should recolor the hairline instead of adding a thick outer halo"
    )
    const composerClassBlocks = [
      ...chatInterface.matchAll(
        /className=\{cn\(\s*"composer-surface composer-liquid-surface composer-focus-glow group\/composer relative rounded-3xl",([\s\S]*?)\n\s*\)\}/g
      ),
    ]
    assert.equal(
      composerClassBlocks.length,
      2,
      "the initial and in-chat composers should share the same surface contract"
    )
    for (const [, classBlock] of composerClassBlocks) {
      assert.doesNotMatch(
        classBlock,
        /(?:^|:|\s)ring(?:-\d|-\[)/,
        "composer class utilities should not stack another ring over the hairline border"
      )
    }
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
