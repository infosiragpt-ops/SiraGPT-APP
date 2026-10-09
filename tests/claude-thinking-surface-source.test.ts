import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Claude-style thinking surface", () => {
  it("ships one animated ThinkingCore glyph — the Sira mark in motion — in the think accent", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /export function ClaudeAsterisk/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /import \{ ThinkingCore \} from "@\/components\/brand\/thinking-core"/)
    assert.match(asterisk, /<ThinkingCore/)
    assert.match(asterisk, /data-brand="thinking-core"/)
    assert.doesNotMatch(asterisk, /LEAF_PATH|\[0, 90, 180, 270\]/, "the clover is the brand logo, not the thinking glyph")
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /claude-asterisk--active/)
    // Luis (2026-10-09): the glyph is the official eight-arm mark in motion —
    // the arms open and close around a breathing centre (lib/brand/sira-motion.ts);
    // idle and reduced motion are the static logo. Attributes move per frame; no SMIL.
    // Luis (2026-10-03): monochrome — no trail, no per-part colour;
    // red (tone="error") is the only colour, and only when the system fails.
    assert.match(core, /data-brand-geometry="sira"/)
    assert.match(core, /paint\(svg, frameAt\(now - anchor, geometry\)\)/)
    assert.doesNotMatch(core, /animateMotion|thinking-core__electron|thinking-core__orbit/, "no SMIL electrons")
    assert.doesNotMatch(core, /pathLength=\{100\}|attributeName="stroke-dashoffset"|thinking-core__trail|function Trail/, "no trail")
    assert.doesNotMatch(core, /--think-electron-/, "no per-electron colour")
    assert.match(core, /const ERROR_TINT = "hsl\(var\(--destructive\)\)"/)
    assert.match(core, /failed \? "claude-asterisk--error" : null/)
    assert.match(core, /data-thinking-tone=\{tone\}/)
    assert.match(core, /className="thinking-core__arm"/)
    assert.match(core, /className="thinking-core__tip"/)
    assert.match(core, /className="thinking-core__core"/)
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
    assert.doesNotMatch(css, /@keyframes thinking-core-(pulse|soft)/, "no CSS nucleus beat: the component breathes the centre itself")
    assert.doesNotMatch(css, /@keyframes thinking-core-(orbit|ripple)/, "no CSS orbit/ripple")
    // The mark animates its own attributes and rests under reduced motion; CSS keeps no electron rules.
    assert.doesNotMatch(css, /thinking-core__electron|thinking-core__trail/)
    assert.match(css, /\.claude-asterisk \{ transform-origin: 50% 50%; overflow: visible; \}/)
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
    // Terminal check is an inline currentColor glyph; the error state is the atom itself in the destructive red.
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /function TerminalGlyph/)
    assert.match(loader, /<ClaudeAsterisk size=\{px\} active=\{false\} tone="error" \/>/)
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
