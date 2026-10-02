import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Claude-style thinking surface", () => {
  it("ships one animated ThinkingCore glyph — the atom in motion — in the think accent", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /export function ClaudeAsterisk/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /import \{ ThinkingCore \} from "@\/components\/brand\/thinking-core"/)
    assert.match(asterisk, /<ThinkingCore/)
    assert.match(asterisk, /data-brand="thinking-core"/)
    assert.doesNotMatch(asterisk, /LEAF_PATH|\[0, 90, 180, 270\]/, "the clover is the brand logo, not the thinking glyph")
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /claude-asterisk--active/)
    // Luis (2026-10-02): three electrons travel the three orbits of the atom
    // logo with a trail; idle is the static logo. SMIL moves them along the
    // exact ellipse; the trail is a synced dash on a pathLength-100 copy.
    assert.match(core, /data-brand-geometry="atom"/)
    assert.match(core, /<animateMotion path=\{ORBIT_PATH\}/)
    assert.match(core, /pathLength=\{100\}/)
    assert.match(core, /attributeName="stroke-dashoffset"/)
    assert.match(core, /thinking-core__electron-still/)
    assert.doesNotMatch(core, /thinking-core__ripple/)
    const loaders = source("lib/thinking-loaders.ts")
    assert.match(loaders, /export const CLAUDE_THINK_ACCENT = "currentColor"/)
    const bars = source("components/pensando-bars.tsx")
    assert.match(bars, /<ClaudeAsterisk size=\{size\} active/)
    assert.doesNotMatch(bars, /Dotm3x3_15|SIRA_CELESTE/)
  })

  it("uses the muted think text for every running step and animates only when motion is allowed", () => {
    const css = source("app/globals.css")
    assert.match(css, /--think-accent: hsl\(var\(--foreground\)\);/)
    assert.match(css, /--step-running: var\(--think-text\);/)
    assert.match(css, /--step-running: var\(--think-text, #57534E\);/)
    assert.match(css, /--think-dim: #737373;/)
    assert.match(css, /--think-dim: #A3A3A3;/)
    assert.match(css, /@keyframes thinking-core-pulse/)
    assert.match(css, /@keyframes thinking-core-soft/)
    assert.doesNotMatch(css, /@keyframes thinking-core-(orbit|ripple)/, "orbits are SMIL now; no ripple")
    assert.match(css, /\.claude-asterisk--active \.thinking-core__electron-still \{ display: none; \}/)
    // Reduced motion: the moving electrons and trails hide, the static logo shows, the nucleus only pulses softly.
    assert.match(css, /\.claude-asterisk--active \.thinking-core__trail,\s*\.claude-asterisk--active \.thinking-core__electron-live \{ display: none; \}/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__electron-still \{ display: inline; \}/)
    assert.match(css, /\.thinking-live-label \{ animation: none; \}/)
    assert.doesNotMatch(css, /@keyframes claude-asterisk-(spin|breathe)/)
    assert.doesNotMatch(css, /--step-running: #2563eb;/)
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
    assert.match(loader, /thinking-shimmer-text/)
  })

  it("has no green on any thinking surface (glyph, labels, done rows)", () => {
    for (const rel of [
      "lib/thinking-loaders.ts",
      "components/thinking-status-loader.tsx",
      "components/claude-thinking-timeline.tsx",
      "components/pensando-bars.tsx",
      "components/trace-rail.tsx",
    ]) {
      assert.doesNotMatch(source(rel), /#2E7D32|#66BB6A|#059669|#34d399/i, rel)
    }
    const css = source("app/globals.css")
    assert.doesNotMatch(css, /--step-done: #34d399/)
    assert.doesNotMatch(css, /--step-running: var\(--think-accent/)
    // The shimmer sweeps between the two muted neutral greys.
    assert.match(css, /var\(--think-text\) 35%,\s*var\(--think-text-hi\) 50%,\s*var\(--think-text\) 65%/)
    // The in-app brand ink is monochrome (black & white interface).
    assert.match(css, /--brand: #0A0A0A;/)
    // Terminal check / X are inline currentColor glyphs, not the celeste/red SVG files.
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /function TerminalGlyph/)
    assert.doesNotMatch(loader, /<img/)
  })

  it("collapses to «Pensó durante N s» on every flow", () => {
    const runTrace = source("lib/run-trace.ts")
    assert.match(runTrace, /return `Pensó durante \$\{seconds\} s`/)
    assert.doesNotMatch(runTrace, /Analizado en/)
    const agentTrace = source("components/agent-trace.tsx")
    assert.match(agentTrace, /tThink\("thoughtFor", \{ duration: prettyDuration \}\)/)
    assert.match(agentTrace, /label: reasoningStreaming \? tThink\("thinking"\) : tThink\("thought"\)/)
    assert.match(agentTrace, /<ClaudeAsterisk size=\{14\} active=\{false\} color="currentColor" \/>/)
    assert.doesNotMatch(agentTrace, /"Pensando…"/)
    const es = JSON.parse(source("messages/es.json"))
    assert.equal(es.thinking.thoughtFor, "Pensó durante {duration}")
    assert.equal(es.thinking.thinking, "Pensando…")
  })
})
