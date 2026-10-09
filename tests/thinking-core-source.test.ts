import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"
import {
  THINKING_LIVE_PHRASES,
  THINKING_PHRASE_INTERVAL_MS,
  THINKING_ANNOUNCE_INTERVAL_MS,
  formatThinkingElapsed,
  nextThinkingPhraseIndex,
} from "@/lib/thinking-loaders"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("ThinkingCore — the «Pensando» glyph", () => {
  it("ships the Sira mark in motion: eight arms + dots around a breathing centre, pure SVG in currentColor, animated by attributes (no SMIL, no colour)", () => {
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /export function ThinkingCore\(\{ size = 20, active = true, tone = "default", color, className, title/)
    assert.match(core, /data-thinking-core=\{active \? "active" : "idle"\}/)
    assert.match(core, /data-brand-geometry="sira"/)
    assert.match(core, /viewBox=\{`0 0 \$\{geometry\.size\} \$\{geometry\.size\}`\}/)
    assert.match(core, /color: tint/)
    assert.match(core, /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
    // Luis (2026-10-09): the glyph IS the brand mark — same geometry as
    // SiraMark via the pure motion model; the resting frame is the logo.
    assert.match(core, /import \{ frameAt, logoGeometryFor, openFrame, type SiraFrame, type SiraGeometry \} from "@\/lib\/brand\/sira-motion"/)
    assert.match(core, /const geometry: SiraGeometry = React\.useMemo\(\(\) => logoGeometryFor\(size\), \[size\]\)/)
    assert.match(core, /const resting = React\.useMemo\(\(\) => openFrame\(geometry\), \[geometry\]\)/)
    // Eight arms stroked in the ink, eight tip dots and the centre filled in the ink.
    assert.match(core, /<g className="thinking-core__arms" stroke="currentColor" strokeWidth=\{geometry\.stroke\} strokeLinecap="round">/)
    assert.match(core, /<line key=\{arm\.index\} className="thinking-core__arm"/)
    assert.match(core, /<g className="thinking-core__dots" fill="currentColor">/)
    assert.match(core, /<circle key=\{arm\.index\} className="thinking-core__tip"/)
    assert.match(core, /<circle className="thinking-core__core" cx=\{resting\.centre\} cy=\{resting\.centre\} r=\{resting\.centerRadius\} \/>/)
    assert.doesNotMatch(core, /Gradient|<filter|url\(#|#2E7D32"|LEAF_PATH|rotate\(\$\{deg\}\)|A170 62|animateMotion|thinking-core__electron|thinking-core__orbit/)
    // The animation moves attributes per frame (requestAnimationFrame) and
    // pauses when hidden or out of view; reduced motion and idle paint the resting frame.
    assert.match(core, /paint\(svg, frameAt\(now - anchor, geometry\)\)/)
    assert.match(core, /raf = requestAnimationFrame\(tick\)/)
    assert.match(core, /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/)
    assert.match(core, /if \(reduced\?\.matches\) \{\n\s+paint\(svg, resting\)/)
    assert.match(core, /document\.addEventListener\("visibilitychange", onVisibility\)/)
    assert.match(core, /new IntersectionObserver\(/)
    assert.match(core, /line\.setAttribute\("visibility", arm\.distance > 0 \? "visible" : "hidden"\)/, "a closed arm never shows its round caps")
    assert.doesNotMatch(core, /pathLength=\{100\}|stroke-dashoffset|TRAIL_LONG|TRAIL_SHORT|thinking-core__trail|function Trail|thinking-core__ripple/)
    // Monochrome: the mark inherits the ink; the only colour is the error tone (destructive red).
    assert.doesNotMatch(core, /--think-electron-/)
    assert.match(core, /const ERROR_TINT = "hsl\(var\(--destructive\)\)"/)
    assert.match(core, /const tint = failed \? ERROR_TINT : color \|\| `var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)`/)
    assert.match(source("components/brand/index.ts"), /export \{ ThinkingCore \} from "\.\/thinking-core"/)
  })

  it("ClaudeAsterisk is a thin wrapper over ThinkingCore keeping its data attributes and classes", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /import \{ ThinkingCore \} from "@\/components\/brand\/thinking-core"/)
    assert.match(asterisk, /<ThinkingCore\n\s+size=\{size\}\n\s+active=\{active\}\n\s+tone=\{tone\}\n\s+color=\{color\}/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /data-claude-asterisk-weight="fine"/)
    assert.doesNotMatch(asterisk, /<svg|<path/)
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /"claude-asterisk",\n\s+"thinking-core",\n\s+active \? "claude-asterisk--active" : "claude-asterisk--idle",\n\s+failed \? "claude-asterisk--error" : null/)
    // Consumers untouched.
    assert.match(source("components/pensando-bars.tsx"), /<ClaudeAsterisk size=\{size\} active/)
    assert.match(source("components/trace-rail.tsx"), /<ClaudeAsterisk size=\{12\} active \/>/)
    assert.match(source("components/agent-trace.tsx"), /<ClaudeAsterisk size=\{14\} active=\{false\} color="currentColor" \/>/)
  })

  it("keeps the CSS to the box and the label pulse: the mark animates itself and rests under reduced motion", () => {
    const css = source("app/globals.css")
    assert.doesNotMatch(css, /@keyframes thinking-core-orbit|@keyframes thinking-core-ripple/, "no CSS orbit/ripple")
    assert.doesNotMatch(css, /@keyframes thinking-core-(pulse|soft)/, "no CSS nucleus beat")
    assert.doesNotMatch(css, /thinking-core__electron/, "no electron rules: the mark has arms, dots and a centre now")
    assert.match(css, /\.claude-asterisk \{ transform-origin: 50% 50%; overflow: visible; \}/)
    assert.match(css, /\.thinking-live-label \{ animation: thinking-live-label-pulse 1\.2s ease-in-out infinite; \}/)
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  /* The thinking mark itself stops in the component"))
    assert.match(reduced, /\.thinking-live-label \{ animation: none; \}/)
    assert.doesNotMatch(css, /thinking-core__trail/)
    assert.doesNotMatch(css, /claude-asterisk-spin|claude-asterisk-breathe/)
  })

  it("tells the user frequently that it is thinking: real step labels (phrases only as fallback) + elapsed seconds, throttled for screen readers", () => {
    assert.ok(THINKING_LIVE_PHRASES.length >= 5)
    assert.equal(THINKING_LIVE_PHRASES[0], "Pensando…")
    assert.ok(THINKING_LIVE_PHRASES.includes("Analizando tu solicitud…"))
    assert.ok(THINKING_LIVE_PHRASES.includes("Casi listo…"))
    for (const phrase of THINKING_LIVE_PHRASES) assert.doesNotMatch(phrase, /[\u{1F300}-\u{1FAFF}]/u, "no emoji")
    assert.equal(THINKING_PHRASE_INTERVAL_MS, 3500)
    assert.equal(THINKING_ANNOUNCE_INTERVAL_MS, 10000)
    // Never the same phrase twice in a row, for any random draw.
    for (let prev = 0; prev < THINKING_LIVE_PHRASES.length; prev++) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999, 1]) {
        const next = nextThinkingPhraseIndex(prev, () => r)
        assert.notEqual(next, prev)
        assert.ok(next >= 0 && next < THINKING_LIVE_PHRASES.length)
      }
    }
    assert.equal(formatThinkingElapsed(12), "12 s")
    assert.equal(formatThinkingElapsed(65.9), "1 min 5 s")
    assert.equal(formatThinkingElapsed(-3), "0 s")

    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /const live = state === "pensando" && !terminal && !hideLabel && !explicitLabel/)
    assert.match(loader, /nextThinkingPhraseIndex\(prev\)\), THINKING_PHRASE_INTERVAL_MS\)/)
    assert.match(loader, /setElapsed\(Math\.floor\(\(Date\.now\(\) - started\) \/ 1000\)\), 1000\)/, "elapsed ticks every second")
    assert.match(loader, /THINKING_ANNOUNCE_INTERVAL_MS\)/)
    assert.match(loader, /aria-atomic=\{announce \? true : undefined\}/)
    assert.match(loader, /live && "thinking-live-label"/)
    // Every in-progress label ticks «· N s» and stays aria-hidden; only the
    // throttled sr-only copy reaches screen readers.
    assert.match(loader, /const ticking = !terminal && !hideLabel/)
    assert.match(loader, /aria-hidden=\{ticking \? true : undefined\}/)
    assert.match(loader, /`· \$\{elapsed\}`/)
    assert.match(loader, /<span className="sr-only" data-thinking-announce="1">/)
    // «Pensó durante N s» after completion is untouched.
    assert.match(source("lib/run-trace.ts"), /return `Pensó durante \$\{seconds\} s`/)
  })
})
