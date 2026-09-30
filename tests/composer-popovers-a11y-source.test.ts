import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("composer popovers and panels — accessibility and monochrome", () => {
  it("announces the highlighted slash command and consumes Esc without IME interference", () => {
    const menu = source("components/SlashCommandMenu.tsx")
    assert.match(menu, /aria-label="Comandos"/)
    assert.doesNotMatch(menu, /aria-label="Slash commands"/)
    assert.match(menu, /role="status" aria-live="polite" aria-atomic="true"/)
    assert.match(menu, /\$\{activeIdx \+ 1\} de \$\{visible\.length\}/)
    assert.match(menu, /if \(e\.isComposing \|\| e\.keyCode === 229\) return/)
    assert.match(menu, /e\.key === "Escape"\) \{[\s\S]{0,200}e\.preventDefault\(\)[\s\S]{0,40}onClose\(\)/)
  })

  it("announces a parked decision and marks the chosen option without blue", () => {
    const panel = source("components/chat/decision-panel.tsx")
    assert.match(panel, /className="sr-only" role="status" aria-live="polite"/)
    assert.match(panel, /El agente necesita tu decisión/)
    assert.match(panel, /aria-pressed=\{isSelected\}/)
    assert.match(panel, /focus-visible:ring-2 focus-visible:ring-ring\/50/)
    assert.match(panel, /shadow-\[inset_0_0_0_1\.5px_hsl\(var\(--foreground\)\)\]/)
    assert.doesNotMatch(panel, /#3B82F6/i)
  })

  it("exposes the active permission level and hides decorative glyphs", () => {
    const menu = source("components/chat/composer-permission-menu.tsx")
    assert.match(menu, /aria-pressed=\{selected\}/)
    assert.match(menu, /aria-keyshortcuts=\{String\(index \+ 1\)\}/)
    assert.match(menu, /<RowIcon [^>]*aria-hidden \/>/)
    assert.match(menu, /<Check [^>]*aria-hidden \/>/)
    assert.match(menu, /<span aria-hidden>\{index \+ 1\}<\/span>/)
    assert.match(menu, /<ul aria-labelledby="composer-permission-kicker"/)
  })

  it("keeps the document remove button visible on touch devices without hover", () => {
    const displays = source("components/chat/ComposerInlineDisplays.tsx")
    assert.match(displays, /sm:\[@media\(hover:hover\)\]:opacity-0 sm:group-hover\/document:opacity-100/)
    assert.doesNotMatch(displays, /sm:w-7 sm:opacity-0/)
  })

  it("sizes the /agentes loader to the app viewport and prefetches the chat chunk during auth", () => {
    const surface = source("components/agents-home-surface.tsx")
    assert.match(surface, /h-\[var\(--app-viewport-height,100dvh\)\]/)
    assert.doesNotMatch(surface, /min-h-screen/)
    assert.match(surface, /const prefetchChatInterface = \(\) => import\("@\/components\/chat-interface-enhanced"\)/)
    assert.match(surface, /if \(user \|\| \(isLoading && hasStoredSession\(\)\)\)/)
  })
})
