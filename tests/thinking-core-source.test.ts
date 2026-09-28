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
  it("ships a pure-SVG neural core drawn in currentColor (no clover, no gradients)", () => {
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /export function ThinkingCore\(\{ size = 20, active = true, color, className, title/)
    assert.match(core, /data-thinking-core=\{active \? "active" : "idle"\}/)
    assert.match(core, /viewBox="0 0 24 24"/)
    assert.match(core, /color: tint/)
    assert.match(core, /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
    assert.equal((core.match(/stroke="currentColor"/g) || []).length, 3, "two orbits + one ripple stroke")
    assert.match(core, /fill="currentColor"/)
    assert.doesNotMatch(core, /Gradient|<filter|url\(#|#2E7D32"|LEAF_PATH|rotate\(\$\{deg\}\)/)
    assert.match(core, /rotate\(-60 12 12\)/)
    assert.match(core, /rotate\(60 12 12\)/)
    assert.match(core, /thinking-core__orbit--a/)
    assert.match(core, /thinking-core__orbit--b/)
    assert.match(core, /thinking-core__ripple/)
    assert.match(core, /thinking-core__core/)
    assert.match(core, /\{active \? <circle className="thinking-core__ripple"/, "idle renders no ripple")
    assert.match(core, /<g>\n\s+<g className="thinking-core__orbit/, "outer <g> stays attribute-free")
    assert.match(source("components/brand/index.ts"), /export \{ ThinkingCore \} from "\.\/thinking-core"/)
  })

  it("ClaudeAsterisk is a thin wrapper over ThinkingCore keeping its data attributes and classes", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /import \{ ThinkingCore \} from "@\/components\/brand\/thinking-core"/)
    assert.match(asterisk, /<ThinkingCore\n\s+size=\{size\}\n\s+active=\{active\}\n\s+color=\{color\}/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /data-claude-asterisk-weight="fine"/)
    assert.doesNotMatch(asterisk, /<svg|<path/)
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /"claude-asterisk", "thinking-core", active \? "claude-asterisk--active" : "claude-asterisk--idle"/)
    // Consumers untouched.
    assert.match(source("components/pensando-bars.tsx"), /<ClaudeAsterisk size=\{size\} active/)
    assert.match(source("components/trace-rail.tsx"), /<ClaudeAsterisk size=\{12\} active \/>/)
    assert.match(source("components/agent-trace.tsx"), /<ClaudeAsterisk size=\{14\} active=\{false\} color="currentColor" \/>/)
  })

  it("animates orbits, heartbeat and ripple in CSS, with a reduced-motion fallback", () => {
    const css = source("app/globals.css")
    assert.match(css, /@keyframes thinking-core-orbit \{/)
    assert.match(css, /@keyframes thinking-core-orbit-reverse \{/)
    assert.match(css, /@keyframes thinking-core-pulse \{\n\s+0%, 100% \{ transform: scale\(0\.85\); opacity: 0\.7; \}\n\s+50% \{ transform: scale\(1\.1\); opacity: 1; \}/)
    assert.match(css, /@keyframes thinking-core-ripple \{\n\s+0% \{ transform: scale\(1\); opacity: 0\.55; \}\n\s+100% \{ transform: scale\(2\.75\); opacity: 0; \}/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__orbit--a \{\n\s+animation: thinking-core-orbit 4s linear infinite;/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__orbit--b \{\n\s+animation: thinking-core-orbit-reverse 6\.5s linear infinite;/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__core \{\n\s+animation: thinking-core-pulse 1\.2s ease-in-out infinite;/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__ripple \{\n\s+animation: thinking-core-ripple 1\.6s ease-out infinite;/)
    assert.match(css, /\.claude-asterisk--idle \.thinking-core__ripple \{ display: none; \}/)
    assert.match(css, /\.thinking-live-label \{ animation: thinking-live-label-pulse 1\.2s ease-in-out infinite; \}/)
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .claude-asterisk--active .thinking-core__orbit--a"))
    assert.match(reduced, /\.thinking-live-label \{ animation: none; \}/)
    assert.match(reduced, /\.claude-asterisk--active \.thinking-core__ripple \{ display: none; \}/)
    assert.match(reduced, /\.claude-asterisk--active \.thinking-core__core \{ animation: thinking-core-soft 2s ease-in-out infinite; \}/)
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
