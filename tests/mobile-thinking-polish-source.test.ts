import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

// Luis (2026-10-03, iPhone screenshot): the black «Contraer barra lateral ⌘B»
// tooltip must never show on a phone, and the «Pensando» mark is monochrome
// (the eight-arm Sira mark opening and closing, no trail, no colour) — red only when the system fails.
describe("mobile polish: no touch tooltips, monochrome thinking mark", () => {
  it("every tooltip carries .ui-tooltip and the stylesheet hides it where hover does not exist", () => {
    const tooltip = source("components/ui/tooltip.tsx")
    assert.match(tooltip, /"ui-tooltip z-\[9999\]/)
    const css = source("app/globals.css")
    const block = css.slice(css.indexOf("Touch devices: no hover tooltips"))
    assert.match(block, /@media \(hover: none\) \{\s*\.ui-tooltip,\s*\[data-radix-popper-content-wrapper\]:has\(> \.ui-tooltip\) \{\s*display: none !important;\s*\}\s*\}/)
    // The sidebar toggle keeps its accessible name (the tooltip was only the hover echo of it).
    const sidebar = source("components/app-sidebar.tsx")
    assert.match(sidebar, /aria-label="Contraer barra lateral ⌘B"/)
  })

  it("the thinking mark is plain ink arms and dots opening in staggered ranks, and turns red only with tone=\"error\"", () => {
    const core = source("components/brand/thinking-core.tsx")
    assert.doesNotMatch(core, /Trail|stroke-dashoffset|--think-electron-|animateMotion/)
    assert.match(core, /<g className="thinking-core__dots" fill="currentColor">/)
    const motion = source("lib/brand/sira-motion.ts")
    assert.match(motion, /ARM_RANKS: readonly number\[\] = Object\.freeze\(\[0, 2, 1, 3, 0, 2, 1, 3\]\)/, "four staggered ranks so the arms never move as one block")
    assert.match(motion, /stagger: 10/)
    assert.match(core, /const tint = failed \? ERROR_TINT : color \|\| `var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)`/)
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /tone=\{tone\}/)
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /tone="error"/)
    const css = source("app/globals.css")
    assert.doesNotMatch(css, /--think-electron-[abc]: #/)
  })
})
