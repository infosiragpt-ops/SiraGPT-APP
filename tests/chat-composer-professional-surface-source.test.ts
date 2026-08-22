import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const globalsPath = path.join(process.cwd(), "app", "globals.css")
const globals = fs.readFileSync(globalsPath, "utf8")
const chatInterfacePath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const chatInterface = fs.readFileSync(chatInterfacePath, "utf8")
const composerSurfacePath = path.join(process.cwd(), "components", "chat", "ChatComposerSurface.tsx")
const composerSurface = fs.readFileSync(composerSurfacePath, "utf8")
const composerLayoutPath = path.join(process.cwd(), "lib", "composer-layout.ts")
const composerLayout = fs.readFileSync(composerLayoutPath, "utf8")

describe("professional chat composer surface source contract", () => {
  it("uses one neutral solid surface without stacked rings or glass", () => {
    assert.match(
      globals,
      /\.composer-surface\s*\{[\s\S]{0,180}border: 1px solid hsl\(220 10% 86% \/ 0\.96\)/,
      "the light composer should use a crisp neutral one-pixel outline"
    )
    assert.match(
      globals,
      /\.dark \.composer-surface\s*\{[\s\S]{0,160}border: 1px solid hsl\(var\(--composer-border\) \/ 0\.96\)/,
      "the dark composer should use the same one-pixel outline"
    )
    const surfaceRule = globals.match(/\.composer-surface\s*\{([^}]*)\}/)?.[1]
    assert.ok(surfaceRule, "the composer surface rule should exist")
    assert.match(surfaceRule, /background-color: hsl\(0 0% 100%\);/)
    assert.match(surfaceRule, /0 8px 24px -20px hsl\(220 24% 14% \/ 0\.24\)/)
    assert.doesNotMatch(
      surfaceRule,
      /linear-gradient|backdrop-filter|inset/,
      "the chat surface should stay solid and use only restrained elevation"
    )
    const focusRule = globals.match(/\.composer-surface:focus-within\s*\{([^}]*)\}/)?.[1]
    assert.ok(focusRule, "the composer focus rule should exist")
    assert.doesNotMatch(
      focusRule,
      /(?:^|\n)\s*0 0 0 [\d.]+px/,
      "focus should strengthen the contour instead of adding a thick outer halo"
    )
    assert.match(
      globals,
      /\.composer-surface:focus-within\s*\{[\s\S]{0,180}inset 0 0 0 1px hsl\(220 9% 72% \/ 0\.22\)/,
      "focused text should strengthen the complete neutral contour"
    )
    assert.match(
      globals,
      /\.composer-textarea:focus-visible\s*\{\s*outline: none !important;/,
      "textarea focus must not leave clipped accent fragments at the rounded corners"
    )
    assert.doesNotMatch(
      globals,
      /\.composer-surface:focus-within\s*\{[^}]*accent-violet/,
      "focus should remain neutral instead of turning into a branded glow"
    )
    const composerClassBlocks = [
      ...composerSurface.matchAll(
        /className=\{cn\(\s*"composer-surface group\/composer relative",([\s\S]*?)\n\s*\)\}/g
      ),
    ]
    assert.equal(
      composerClassBlocks.length,
      1,
      "empty-state and in-chat composers should share one surface component"
    )
    for (const [, classBlock] of composerClassBlocks) {
      assert.doesNotMatch(
        classBlock,
        /(?:^|:|\s)(?:ring|shadow)(?:-\d|-\[)/,
        "composer utilities should not stack a ring or second shadow"
      )
    }
    assert.doesNotMatch(
      `${chatInterface}\n${composerSurface}`,
      /composer-surface composer-liquid-surface/,
      "the chat composer should not opt back into the decorative liquid treatment"
    )
    assert.match(
      globals,
      /\.composer-focus-glow::before\s*\{\s*content: none;\s*display: none;/,
      "the old animated conic focus ring should stay disabled"
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
      /\.composer-input-row \.composer-model-inline \.chat-model-trigger\s*\{[\s\S]{0,220}background-color: transparent;[\s\S]{0,80}box-shadow: none;/,
      "the model selector should read as an inline control, not a nested capsule"
    )
    assert.match(
      globals,
      /\.composer-input-row \.composer-model-inline \.chat-model-trigger:hover,[\s\S]{0,180}background-color: hsl\(220 10% 94% \/ 0\.82\);/,
      "the inline model selector should reveal a quiet hover state"
    )
    assert.doesNotMatch(
      globals,
      /\.dark \.composer-input-row \.composer-model-inline \.chat-model-trigger\s*\{[^}]*border-color:/,
      "dark mode should not put the model selector back inside a bordered capsule"
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
    assert.match(
      globals,
      /\.composer-input-row \.composer-toolbar-actions > button\.composer-send-button\s*\{[\s\S]{0,180}background-color: #0a0a0a !important;[\s\S]{0,80}color: #ffffff !important;/,
      "the send disc must stay solid black with a white arrow"
    )
  })

  it("keeps one uninterrupted surface while preserving accessible controls", () => {
    assert.doesNotMatch(
      globals,
      /\.composer-input-row::before\s*\{/,
      "the composer should not split into a separate lower command rail"
    )
    assert.match(
      globals,
      /\.composer-plus-liquid-button\s*\{[\s\S]{0,260}border: none !important;[\s\S]{0,140}background: transparent;[\s\S]{0,80}box-shadow: none;/,
      "the attachment action should remain a plain icon inside the shared surface"
    )
    assert.doesNotMatch(
      chatInterface,
      /rgba\(109,40,217/,
      "the composer should not carry the old decorative purple focus shadow"
    )
    assert.equal(
      (chatInterface.match(/aria-label="Mensaje para SiraGPT"/g) || []).length,
      1,
      "both composer paths should expose the same accessible message label"
    )
    assert.equal(
      (chatInterface.match(/enterKeyHint="send"/g) || []).length,
      1,
      "mobile keyboards should expose the send action consistently"
    )
    assert.equal(
      (chatInterface.match(/\{renderChatComposer\(\)\}/g) || []).length,
      2,
      "empty-state and in-chat composers must render the same extracted surface"
    )
  })

  it("uses the compact professional rhythm on desktop and mobile", () => {
    assert.match(
      globals,
      /\.composer-input-row\s*\{[\s\S]{0,420}display: grid !important;[\s\S]{0,160}grid-template-areas: "leading text actions";[\s\S]{0,160}min-height: 3\.35rem;[\s\S]{0,120}padding: 0\.4rem 0\.45rem 0\.4rem 0\.4rem !important;/,
      "the idle composer should keep a single-row Claude/ChatGPT control bar"
    )
    assert.match(
      globals,
      /\.composer-surface\[data-composer-stacked="true"\] \.composer-input-row\s*\{[\s\S]{0,220}grid-template-areas:[\s\S]{0,80}"text text text"[\s\S]{0,80}"leading leading actions";/,
      "wrapped text must drop the model picker onto the composer footer"
    )
    assert.match(
      globals,
      /@media \(max-width: 640px\)[\s\S]{0,320}\.composer-surface\s*\{\s*border-radius: 1\.75rem;[\s\S]{0,220}min-height: 3\.25rem;/,
      "phones should keep the same compact single-row hierarchy"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell \.composer-textarea\s*\{[\s\S]{0,280}display: block !important;[\s\S]{0,260}padding: 0\.2rem 0\.35rem 0\.2rem 0\.2rem !important;/,
      "placeholder/input must sit on a comfortable single-line rhythm next to 44px actions"
    )
    assert.equal(
      (chatInterface.match(/"composer-textarea textarea-scrollbar[^"]*",\s*"p-0"/g) || []).length,
      1,
      "the shared textarea should drop utility padding so CSS can pin the first line"
    )
    assert.equal(
      (composerSurface.match(/className="composer-input-row"/g) || []).length,
      1,
      "both composer paths should rely on the shared CSS row contract"
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
      /\.chat-composer-dock\s*\{[\s\S]{0,220}padding: 0\.25rem var\(--chat-mobile-gutter\)/,
      "the dock should use the shared mobile gutter token for side margins"
    )
    assert.match(
      globals,
      /\.chat-viewport\[data-chat-keyboard="open"\] \.chat-message-scroll-content,[\s\S]{0,180}padding-bottom: calc\([\s\S]{0,180}var\(--chat-composer-height, 112px\)/,
      "only the iOS fixed-keyboard state should reserve composer height"
    )
    assert.match(
      globals,
      /\.chat-composer-frame\s*\{[\s\S]{0,180}width: min\(100%, var\(--chat-content-max-width\)\);[\s\S]{0,80}margin-inline: auto;/,
      "the empty composer should retain its approved 828px content width"
    )
    assert.match(
      globals,
      /\.chat-initial-stage \.chat-composer-frame\s*\{[\s\S]{0,100}width: min\(100%, var\(--chat-content-max-width\)\);/,
      "empty-stage must not double-inset the frame after the stage gutters"
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
      /\.composer-textarea-shell\s*\{[\s\S]{0,200}height: auto;[\s\S]{0,120}min-height: 1\.65rem;[\s\S]{0,120}max-height: min\(12\.5rem, 42vh\);[\s\S]{0,80}overflow: hidden;/,
      "short prompts stay compact; long prompts grow then scroll inside the shell"
    )
    assert.match(
      globals,
      /\.composer-textarea-shell \.composer-textarea\s*\{[\s\S]{0,280}min-height: 1\.65rem !important;[\s\S]{0,120}max-height: min\(12\.5rem, 42vh\) !important;/,
      "the textarea should grow with content up to a professional max height"
    )
    assert.match(
      chatInterface,
      /resizeComposerTextarea[\s\S]{0,1600}scrollHeight[\s\S]{0,800}style\.height/,
      "typing should auto-grow the textarea height from scrollHeight"
    )
    assert.match(
      composerLayout,
      /export function shouldStackComposer/,
      "stacking the footer toolbar must live in a pure layout helper"
    )
    assert.match(
      chatInterface,
      /data-testid="chat-composer-expand"/,
      "the /chat composer exposes the same Ampliar/Contraer control as /code"
    )
    assert.match(
      chatInterface,
      /aria-label=\{composerExpanded \? "Contraer" : "Ampliar"\}/,
      "expand control uses Ampliar / Contraer labels"
    )
    assert.doesNotMatch(
      chatInterface,
      /chat-composer-expand[\s\S]{0,500}hidden md:/,
      "expand must stay visible on phone — not hidden md: only"
    )
    assert.doesNotMatch(
      chatInterface,
      /ActionsDropdown[\s\S]{0,220}data-testid="chat-composer-expand"/,
      "expand must not stay a permanent sibling of +"
    )
    assert.match(
      chatInterface,
      /composer-textarea-shell[\s\S]{0,500}has-expand-control[\s\S]{0,500}chat-composer-expand/,
      "expand overlays the textarea shell instead of the bottom toolbar"
    )
    assert.match(
      chatInterface,
      /composerShowExpand \? \(/,
      "expand is gated; it is not rendered next to + on every short draft"
    )
    assert.match(
      composerLayout,
      /export function shouldShowComposerExpandControl/,
      "overflow gating lives in the shared layout helper"
    )
    assert.match(
      globals,
      /\.composer-expand-button\s*\{[\s\S]{0,180}position: absolute;[\s\S]{0,80}top: 0\.05rem;[\s\S]{0,80}right: 0\.05rem;/,
      "expand sits on the textarea top-right corner"
    )
    assert.doesNotMatch(
      chatInterface,
      /getComposerTextareaMaxHeight|composerIsExpanded/,
      "legacy expand flag names stay unused"
    )
    assert.equal(
      (composerSurface.match(/data-testid="chat-composer-surface"/g) || []).length,
      1,
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
      (composerSurface.match(/className="composer-context-tray"/g) || []).length,
      1,
      "both composer render paths should use the context tray"
    )
    // The tray must be a child of the surface: dropped files sit within the
    // same rounded border as the input, never as a floating card above it.
    assert.equal(
      (composerSurface.match(
        /data-testid="chat-composer-surface"[\s\S]{0,1400}?className="composer-context-tray"/g
      ) || []).length,
      1,
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
