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

  it("preserves the approved width and height across chat states", () => {
    assert.match(
      globals,
      /\.chat-composer-frame\s*\{[\s\S]{0,180}width: min\(calc\(100% - 2rem\), 51\.75rem\);[\s\S]{0,80}margin-inline: auto;/,
      "the empty composer should retain its approved 828px content width"
    )
    assert.match(
      globals,
      /\.chat-composer-dock \.chat-composer-frame\s*\{[\s\S]{0,100}width: min\(100%, 51\.75rem\);/,
      "the in-chat composer should use the same approved width"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell\s*\{[\s\S]{0,160}height: 2\.2rem;[\s\S]{0,80}max-height: 2\.2rem;[\s\S]{0,80}overflow: hidden;/,
      "long prompts should scroll internally instead of resizing the surface"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell \.composer-textarea\s*\{[\s\S]{0,220}height: 2\.2rem !important;[\s\S]{0,100}max-height: 2\.2rem !important;[\s\S]{0,100}overflow-y: auto !important;/,
      "the textarea height must remain fixed in every text state"
    )
    assert.doesNotMatch(
      chatInterface,
      /data-expanded=|getComposerTextareaMaxHeight|composerIsExpanded/,
      "no runtime state should opt the composer back into auto expansion"
    )
    assert.equal(
      (chatInterface.match(/data-testid="chat-composer-surface"/g) || []).length,
      2,
      "both composer render paths should expose the same measurable surface"
    )
  })

  it("keeps attachments and connector context outside the fixed input surface", () => {
    assert.match(
      globals,
      /\.composer-context-tray:empty\s*\{\s*display: none;/,
      "an unused context tray should reserve no space"
    )
    assert.equal(
      (chatInterface.match(/className="composer-context-tray"/g) || []).length,
      2,
      "both composer render paths should use the independent context tray"
    )
  })
})
