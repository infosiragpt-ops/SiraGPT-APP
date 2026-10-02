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

  it("the ThinkingCore glyph keeps the Claude weight contract at Claude sizes", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /data-claude-asterisk-weight="fine"/)
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /viewBox="0 0 24 24"/)
    assert.doesNotMatch(core, /thinking-core__ring/, "dots only: no orbit rings (Luis, 2026-10-02)")
    assert.match(core, /r="1\.7" fill="currentColor"/, "electrons are small dots")
    assert.match(core, /<circle className="thinking-core__core" cx="12" cy="12" r="2\.6" fill="currentColor" \/>/)
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
