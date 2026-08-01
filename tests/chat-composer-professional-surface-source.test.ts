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
      /\.composer-surface\s*\{[\s\S]{0,220}border: 0\.5px solid hsl\(220 14% 78% \/ 0\.94\)/,
      "the light composer should use a half-pixel hairline border"
    )
    assert.match(
      globals,
      /\.dark \.composer-surface\s*\{[\s\S]{0,160}border: 0\.5px solid hsl\(var\(--composer-border\) \/ 0\.96\)/,
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
      /\.composer-surface\.composer-liquid-surface\s*\{[\s\S]{0,360}linear-gradient\(180deg, hsl\(0 0% 100% \/ 0\.88\)[\s\S]{0,220}backdrop-filter: blur\(28px\) saturate\(1\.85\);/,
      "the light composer should use a translucent liquid-glass surface that beats the solid fallback"
    )
    assert.match(
      globals,
      /\.chat-composer-dock::before\s*\{\s*content: none;\s*display: none;/,
      "the dock must not fade or hide the transcript above the composer"
    )
    assert.match(
      chatInterface,
      /data-testid="chat-scroll-to-bottom"[\s\S]{0,260}absolute left-1\/2 -top-11 z-20[\s\S]{0,260}translate-y-2 opacity-0[\s\S]{0,120}translate-y-0 opacity-100/,
      "the scroll-to-bottom pill should float without reserving a blank row"
    )
    assert.match(
      chatInterface,
      /absolute left-1\/2 -top-11 z-20 flex -translate-x-1\/2/,
      "the scroll-to-bottom pill should stay centered immediately above the composer"
    )
    assert.match(
      chatInterface,
      /className="chat-composer-frame relative flex flex-col gap-2"/,
      "the dock frame should use flex gap so an absolute pill cannot create phantom spacing"
    )
    assert.match(
      globals,
      /\.composer-liquid-surface::before\s*\{\s*content: \"\";[\s\S]{0,260}background:[\s\S]{0,80}linear-gradient\(180deg,/,
      "the composer should keep one restrained top-glare layer"
    )
    assert.match(
      globals,
      /\.composer-surface\.composer-liquid-surface::after\s*\{\s*content: none;\s*display: none !important;/,
      "the composer should avoid a second decorative pseudo-layer"
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
      /\.composer-input-row\s*\{[\s\S]{0,420}align-items: start;[\s\S]{0,120}min-height: 5\.25rem;[\s\S]{0,100}padding: 0\.28rem 0\.75rem 0\.4rem !important;/,
      "the idle composer should pin text to the top hairline without oversized vertical space"
    )
    assert.match(
      globals,
      /@media \(max-width: 640px\)[\s\S]{0,320}\.composer-surface\s*\{\s*border-radius: 1\.5rem;[\s\S]{0,180}min-height: 5\.25rem;/,
      "phones should keep the same compact hierarchy without oversized rounding"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell \.composer-textarea\s*\{[\s\S]{0,280}display: block !important;[\s\S]{0,220}padding: 0\.02rem 0\.15rem 0\.05rem !important;/,
      "placeholder/input must sit flush against the upper bar hairline"
    )
    assert.equal(
      (chatInterface.match(/"composer-textarea textarea-scrollbar[^"]*",\s*"p-0"/g) || []).length,
      2,
      "both textareas should drop utility padding so CSS can pin the first line"
    )
  })

  it("preserves the approved width and height across chat states", () => {
    assert.match(
      globals,
      /\.chat-viewport\s*\{[^}]{0,1600}--chat-content-max-width: 51\.75rem;/,
      "the chat viewport should own one 828px width token for messages and composer"
    )
    assert.match(
      globals,
      /\.chat-message-scroll-content\s*\{[\s\S]{0,180}padding: calc\(var\(--chat-header-height, 64px\) \+ 1rem\) var\(--chat-mobile-gutter\)\s+0\.25rem;/,
      "the normal scroll area should end flush against the composer's top edge"
    )
    assert.match(
      globals,
      /\.chat-composer-dock\s*\{[\s\S]{0,180}padding: 0\.125rem 1rem/,
      "the dock should leave only a two-pixel breathing edge above the composer"
    )
    assert.match(
      globals,
      /\.chat-viewport\[data-chat-keyboard="open"\] \.chat-message-scroll-content,[\s\S]{0,180}padding-bottom: calc\([\s\S]{0,180}var\(--chat-composer-height, 112px\)/,
      "only the iOS fixed-keyboard state should reserve composer height"
    )
    assert.match(
      globals,
      /\.chat-composer-frame\s*\{[\s\S]{0,180}width: min\(calc\(100% - 2rem\), var\(--chat-content-max-width\)\);[\s\S]{0,80}margin-inline: auto;/,
      "the empty composer should retain its approved 828px content width"
    )
    assert.match(
      globals,
      /\.chat-composer-dock \.chat-composer-frame\s*\{[\s\S]{0,100}width: min\(100%, var\(--chat-content-max-width\)\);/,
      "the in-chat composer should use the same approved width"
    )
    assert.match(
      globals,
      /\.chat-conversation-column\s*\{[\s\S]{0,520}box-sizing: border-box;[\s\S]{0,100}width: 100%;[\s\S]{0,80}min-width: 0;[\s\S]{0,240}var\(--chat-content-max-width\) \+ var\(--chat-mobile-gutter\) \+ var\(--chat-mobile-gutter\)[\s\S]{0,100}margin-inline: auto;/,
      "the transcript content box should share the composer rail after accounting for both gutters"
    )
    assert.doesNotMatch(
      globals,
      /\.chat-conversation-column\s*\{[^}]*64rem/,
      "the transcript must not regress to the old 1024px rail"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell\s*\{[\s\S]{0,160}height: 2\.2rem;[\s\S]{0,80}max-height: 2\.2rem;[\s\S]{0,80}overflow: hidden;/,
      "long prompts should scroll internally instead of resizing the surface"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell \.composer-textarea\s*\{[\s\S]{0,280}height: 2\.2rem !important;[\s\S]{0,100}max-height: 2\.2rem !important;[\s\S]{0,100}overflow-y: auto !important;/,
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

  it("renders attachments INSIDE the composer border, Claude-style", () => {
    assert.match(
      globals,
      /\.composer-context-tray:empty\s*\{\s*display: none;/,
      "an unused context tray should reserve no space"
    )
    assert.equal(
      (chatInterface.match(/className="composer-context-tray"/g) || []).length,
      2,
      "both composer render paths should use the context tray"
    )
    // The tray must be a child of the surface: dropped files sit within the
    // same rounded border as the input, never as a floating card above it.
    assert.equal(
      (chatInterface.match(
        /data-testid="chat-composer-surface"[\s\S]{0,1400}?className="composer-context-tray"/g
      ) || []).length,
      2,
      "both composers must nest the tray inside the surface"
    )
    // [^}] keeps the check inside the rule body — [\s\S] would spill past the
    // closing brace and false-positive on the next selector's border.
    assert.doesNotMatch(
      globals,
      /\.composer-context-tray\s*\{[^}]{0,300}border: 0\.5px solid/,
      "the tray must not paint its own card border inside the surface"
    )
  })
})
