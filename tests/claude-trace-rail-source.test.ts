import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Claude-style activity rail", () => {
  it("ships one rail component: thin line, outline icon tiles, asterisk while running", () => {
    const rail = source("components/trace-rail.tsx")
    assert.match(rail, /export function TraceRail\(/)
    assert.match(rail, /export function TraceRailRow\(/)
    assert.match(rail, /before:w-px before:bg-border\/70/)
    assert.match(rail, /running \? <ClaudeAsterisk size=\{12\} active \/> : <Icon className="h-3 w-3" strokeWidth=\{1\.75\} \/>/)
    assert.match(rail, /rounded-\[6px\] border bg-background/)
    for (const icon of ["FileText", "SquareTerminal", "Image as ImageIcon", "Search", "Globe"]) assert.match(rail, new RegExp(icon))
    assert.doesNotMatch(rail, /text-\[var\(--step-done/, "done rows are quiet grey, never green text")
  })

  it("the document runner and the full timeline render through the rail, not coloured text lines", () => {
    const steps = source("components/agentic-steps.tsx")
    assert.match(steps, /import \{ TraceRail, TraceRailRow \} from "@\/components\/trace-rail"/)
    assert.equal((steps.match(/<TraceRail>/g) || []).length, 3, "collapsed history, live list and full timeline")
    assert.doesNotMatch(steps, /border-l border-border\/50 pl-3/)
    assert.doesNotMatch(steps, /STEP_STATUS_CLASS\[step\.status === "error" \? "failed" : step\.status === "running" \? "running" : "done"\]/)
    assert.match(steps, /<TraceRailRow[\s\S]*?status=\{step\.status === "error" \? "failed" : step\.status === "running" \? "running" : "done"\}/)
  })

  it("the asterisk is Claude weight (slim arms, small hub) at Claude sizes", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /data-claude-asterisk-weight="fine"/)
    assert.match(asterisk, /d="M20 2\.4c1\.05 0 1\.9\.85 1\.9 1\.9l-\.65 12\.9/)
    assert.match(asterisk, /<circle cx="20" cy="20" r="2\.1" \/>/)
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /chip: 22,\n\s+glyph: 16,/)
    const bars = source("components/pensando-bars.tsx")
    assert.match(bars, /size = 20/)
    const css = source("app/globals.css")
    assert.match(css, /--step-done: #6B6660;/)
    assert.match(css, /--step-done: #A8A29E;/)
    assert.doesNotMatch(css, /--step-done: #059669;/)
  })
})
