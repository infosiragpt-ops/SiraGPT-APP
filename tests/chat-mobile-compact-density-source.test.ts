import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * Luis (2026-10-02, claude.ai side by side on an iPhone): the chat must be as
 * compact as claude.ai. The global 44px touch-target rule (#78) inflated every
 * chat control on phones; the chat surfaces now keep 28–36px geometry and the
 * invisible `::after` tap zone keeps them easy to hit.
 */
describe("compact chat density on phones (claude.ai parity)", () => {
  const css = source("app/globals.css")
  const message = source("components/message-component.tsx")
  const chat = source("components/chat-interface-enhanced.tsx")

  it("exempts the chat header, composer and message rows from the 44px inflation", () => {
    const block = css.slice(css.indexOf("Compact chat density on phones"))
    assert.ok(block.length > 0, "the compact-density block exists")
    assert.match(block, /@media \(pointer: coarse\) \{\s*:is\(\.chat-mobile-header, \.composer-input-row, \.msg--user, \.chat-assistant-message\)\s*button:not\(\[data-no-tap-target\]\):not\(\.no-tap-target\)/)
    assert.match(block, /min-height: 0;\s*min-width: 0;/)
  })

  it("composer controls share a 36px line on phones and the model pill gets the freed width", () => {
    const block = css.slice(css.indexOf("Compact chat density on phones"))
    assert.match(block, /\.composer-plus-liquid-button,\s*\.composer-input-row \.composer-toolbar-actions > button\.composer-dictation-button,\s*\.composer-input-row \.composer-toolbar-actions > button\.composer-send-button,\s*\.composer-input-row \.composer-toolbar-actions > button\.composer-stop-button \{\s*width: 2\.25rem !important;/)
    assert.match(block, /\.composer-permission-chip,\s*\.composer-effort-chip,\s*\.composer-context-trigger \{\s*height: 2\.25rem !important;/)
    assert.match(block, /\.composer-model-inline \{\s*max-width: min\(46vw, max\(3\.5rem, calc\(100vw - 2 \* var\(--chat-mobile-gutter, 0\.75rem\) - 14\.9rem\)\)\) !important;/)
    assert.match(block, /\.composer-input-row \{\s*min-height: 3rem;/)
    assert.match(chat, /className="composer-plus-liquid-button flex h-9 w-9 items-center justify-center rounded-full p-0"/)
  })

  it("the user bubble row reads «hace N min · copiar · editar» with 28px tiles", () => {
    assert.match(message, /import MessageActionRail, \{ formatRelativeTimeEs \} from "\.\/MessageActionRail"/)
    assert.match(message, /const userRelativeTime = message\.role === 'USER'/)
    assert.match(message, /className="msg-user-actions mt-1\.5 flex items-center gap-0\.5 opacity-100/)
    assert.match(message, /\{userRelativeTime\}/)
    assert.equal((message.match(/className="h-7 w-7 text-muted-foreground hover:text-foreground"/g) || []).length, 2, "copy + edit tiles")
    assert.doesNotMatch(message, /className="h-6 w-6"\s*\n\s*aria-label=\{isCopied/)
  })

  it("the mobile header opener is a 36px ghost like the rest of the strip", () => {
    assert.match(chat, /data-testid="chat-mobile-sidebar-open"\s*className="flex h-9 w-9 shrink-0/)
    const block = css.slice(css.indexOf("Compact chat density on phones"))
    assert.match(block, /\.chat-mobile-header \{\s*padding-top: calc\(0\.5rem \+ env\(safe-area-inset-top, 0px\)\);/)
  })
})
