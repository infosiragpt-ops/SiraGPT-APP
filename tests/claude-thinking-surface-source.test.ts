import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Claude-style thinking surface", () => {
  it("ships one animated ThinkingCore glyph in the clover think accent", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /export function ClaudeAsterisk/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /import \{ ThinkingCore \} from "@\/components\/brand\/thinking-core"/)
    assert.match(asterisk, /<ThinkingCore/)
    assert.match(asterisk, /data-brand="thinking-core"/)
    assert.doesNotMatch(asterisk, /LEAF_PATH|\[0, 90, 180, 270\]/, "the clover is the brand logo, not the thinking glyph")
    const core = source("components/brand/thinking-core.tsx")
    assert.match(core, /claude-asterisk--active/)
    const loaders = source("lib/thinking-loaders.ts")
    assert.match(loaders, /export const CLAUDE_THINK_ACCENT = "#2E7D32"/)
    const bars = source("components/pensando-bars.tsx")
    assert.match(bars, /<ClaudeAsterisk size=\{size\} active/)
    assert.doesNotMatch(bars, /Dotm3x3_15|SIRA_CELESTE/)
  })

  it("uses the think accent for every running step and animates only when motion is allowed", () => {
    const css = source("app/globals.css")
    assert.match(css, /--think-accent: #2E7D32;/)
    assert.match(css, /--step-running: var\(--think-accent\);/)
    assert.match(css, /--step-running: var\(--think-accent, #2E7D32\);/)
    assert.match(css, /@keyframes thinking-core-orbit/)
    assert.match(css, /@keyframes thinking-core-pulse/)
    assert.match(css, /@keyframes thinking-core-ripple/)
    assert.match(css, /\.claude-asterisk--active \.thinking-core__ripple,\s*\.thinking-live-label \{ animation: none; \}/)
    assert.doesNotMatch(css, /@keyframes claude-asterisk-(spin|breathe)/)
    assert.doesNotMatch(css, /--step-running: #2563eb;/)
    const loader = source("components/thinking-status-loader.tsx")
    assert.match(loader, /var\(--think-accent, \$\{CLAUDE_THINK_ACCENT\}\)/)
    assert.match(loader, /thinking-shimmer-text/)
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
