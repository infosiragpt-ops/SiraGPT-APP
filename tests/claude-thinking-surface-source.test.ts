import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

describe("Claude-style thinking surface", () => {
  it("ships one animated asterisk glyph in the terracotta think accent", () => {
    const asterisk = source("components/claude-asterisk.tsx")
    assert.match(asterisk, /export function ClaudeAsterisk/)
    assert.match(asterisk, /data-claude-asterisk=\{active \? "active" : "idle"\}/)
    assert.match(asterisk, /claude-asterisk--active/)
    assert.match(asterisk, /\[0, 45, 90, 135, 180, 225, 270, 315\]/)
    const loaders = source("lib/thinking-loaders.ts")
    assert.match(loaders, /export const CLAUDE_THINK_ACCENT = "#D97757"/)
    const bars = source("components/pensando-bars.tsx")
    assert.match(bars, /<ClaudeAsterisk size=\{size\} active/)
    assert.doesNotMatch(bars, /Dotm3x3_15|SIRA_CELESTE/)
  })

  it("uses the think accent for every running step and animates only when motion is allowed", () => {
    const css = source("app/globals.css")
    assert.match(css, /--think-accent: #D97757;/)
    assert.match(css, /--step-running: var\(--think-accent\);/)
    assert.match(css, /--step-running: var\(--think-accent, #D97757\);/)
    assert.match(css, /@keyframes claude-asterisk-spin/)
    assert.match(css, /@keyframes claude-asterisk-breathe/)
    assert.match(css, /\.claude-asterisk--active,\s*\.claude-asterisk--active > g \{ animation: none; \}/)
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
