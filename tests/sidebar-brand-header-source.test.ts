import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * Luis (2026-10-01): the sidebar header opens with the brand lockup — the
 * five-loop knot mark and the «SiraGPT» wordmark — and ends with the collapse
 * toggle on the right; the collapsed rail keeps the knot as its single affordance.
 */
describe("sidebar brand header (knot mark + SiraGPT wordmark)", () => {
  const sidebar = source("components/app-sidebar.tsx")

  it("renders the lockup first in the open header, with the toggle beside it", () => {
    const lockup = sidebar.indexOf('data-testid="sidebar-brand"')
    assert.ok(lockup > 0, "lockup present")
    const header = sidebar.slice(lockup, lockup + 1400)
    assert.match(header, /<KnotMark\s+size=\{22\}\s+title="SiraGPT"\s+gap="hsl\(var\(--sidebar-background\)\)"/)
    assert.match(header, /className="sidebar-brand__wordmark truncate text-\[15px\] leading-none">\s*SiraGPT\s*<\/span>/)
    const wordmark = header.indexOf("sidebar-brand__wordmark")
    const toggle = header.indexOf('aria-label="Contraer barra lateral ⌘B"')
    assert.ok(wordmark > 0 && toggle > wordmark, "the collapse toggle is the only control after the wordmark")
    // Luis (2026-10-01, second pass): the bell and the «Nuevo agente» disc
    // left the header; the toggle sits on the right at a real 32px size.
    assert.doesNotMatch(sidebar, /<NotificationCenter \/>/)
    assert.doesNotMatch(sidebar, /notification-center/)
    assert.doesNotMatch(sidebar, /aria-label="Nuevo agente ⌘N"/)
    assert.doesNotMatch(sidebar, /MessageSquarePlus/)
    assert.match(sidebar, /const HEADER_TOGGLE_BTN =\s*\n\s*"[^"]*\bh-8 w-8\b[^"]*"/)
    assert.match(header, /className=\{HEADER_TOGGLE_BTN\}\s*>\s*<SidebarOvalIcon className="h-5 w-5" \/>/)
    // «Nuevo agente» still exists as the first nav row (and ⌘N).
    assert.match(sidebar, /onClick=\{handleNewChat\}/)
    // The browser history buttons left the strip so the wordmark never truncates.
    assert.doesNotMatch(sidebar, /aria-label="Atrás"/)
    assert.doesNotMatch(sidebar, /aria-label="Adelante"/)
  })

  it("the collapsed rail shows the knot and the mark never falls back to the clover", () => {
    assert.match(sidebar, /<KnotMark\s+size=\{20\}\s+title="SiraGPT"\s+gap="hsl\(var\(--sidebar-background\)\)"/)
    assert.doesNotMatch(sidebar, /CloverMark/)
    const css = source("app/globals.css")
    assert.match(css, /\.sidebar-brand__wordmark \{[\s\S]{0,160}letter-spacing: -0\.02em;/)
  })
})
