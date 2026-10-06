import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

// Luis (2026-10-03, iPhone screenshot): the black «Contraer barra lateral ⌘B»
// tooltip must never show on a phone, and the «Pensando» atom is monochrome
// dots orbiting (no trail, no colour) — red only when the system fails.
describe("mobile polish: no touch tooltips, monochrome thinking atom", () => {
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

  it("the thinking atom is plain ink dots orbiting at different phases, and turns red only with tone=\"error\"", () => {
    const core = source("components/brand/thinking-core.tsx")
    assert.doesNotMatch(core, /Trail|stroke-dashoffset|--think-electron-/)
    assert.match(core, /<circle className="thinking-core__electron-live" r="1\.7" fill="currentColor">/)
    assert.match(core, /begin: "0s"[\s\S]*begin: "-1\.1s"[\s\S]*begin: "-2\.3s"/, "three phases so the dots are never aligned")
    assert.match(core, /const tint = failed \? ERROR_TINT : color \|\| `var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)`/)
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /tone=\{tone\}/)
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /tone="error"/)
    const css = source("app/globals.css")
    assert.doesNotMatch(css, /--think-electron-[abc]: #/)
  })
})
