import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("thinking loaders · live Pensando uses the Luis kit", () => {
  it("renders kit SVGs for loader|sunburst and never the Claude sunburst on the live path", () => {
    const timeline = source("components/claude-thinking-timeline.tsx")
    const loader = source("components/thinking-status-loader.tsx")
    const docs = source("docs/thinking-loaders.md")

    assert.match(timeline, /if \(kind === "sunburst" \|\| kind === "loader"\)/)
    assert.match(timeline, /<ThinkingStatusLoader/)
    assert.match(timeline, /density="glyph"/)
    assert.match(timeline, /loaderChipSrc|ThinkingStatusLoader/)
    assert.doesNotMatch(timeline, /claude-think-sunburst/)
    assert.doesNotMatch(timeline, /function SunburstIcon/)
    assert.match(loader, /data-thinking-loader=\{state\}/)
    assert.match(loader, /loaderChipSrc\(state\)/)
    assert.match(loader, /import \{ PensandoBars \} from "@\/components\/pensando-bars"/)
    assert.match(loader, /<PensandoBars /)
    assert.match(loader, /data-pensando-bars=\{terminal \? undefined : "1"\}/)
    assert.match(docs, /bouncing three-bar SVG/)
    assert.match(docs, /retired/)
  })

  it("ships PensandoBars as the 3×3 dot-matrix ripple hardcoded #38BDF8", () => {
    const bars = source("components/pensando-bars.tsx")
    const svg = source("public/loaders/pensando.svg")
    const icon = source("components/icons/thinking-bars-icon.tsx")
    const indicator = source("components/ui/thinking-indicator.tsx")
    assert.match(bars, /import \{ Dotm3x3_15 \} from "@\/components\/ui\/dotm-3x3-15"/)
    assert.match(bars, /<Dotm3x3_15 size=\{size\} color=\{SIRA_CELESTE\}/)
    assert.match(bars, /data-pensando-bars="1"/)
    assert.doesNotMatch(bars, /currentColor/)
    assert.match(svg, /viewBox="0 0 36 36"/)
    assert.match(svg, /fill="#38BDF8"/)
    assert.doesNotMatch(svg, /currentColor/)
    assert.match(icon, /viewBox="0 0 36 36"/)
    assert.match(icon, /fill=\{SIRA_CELESTE\}/)
    assert.doesNotMatch(icon.replace(/\/\*[\s\S]*?\*\//g, ""), /currentColor/)
    assert.match(indicator, /import \{ PensandoBars \} from "@\/components\/pensando-bars"/)
    assert.match(indicator, /<PensandoBars size=\{px\} \/>/)
    assert.doesNotMatch(indicator, /THINKING_GLYPH_COLOR/)
  })

  it("forces kind loader + pensando state on active ThinkingTrace / AgentTrace rows", () => {
    const trace = source("components/thinking-trace.tsx")
    const agent = source("components/agent-trace.tsx")
    const placeholder = source("components/thinking-placeholder.tsx")

    assert.match(trace, /kind: streaming && !\(toolCalls && toolCalls\.length\) \? "loader" : "dot"/)
    assert.match(trace, /loaderState: streaming && !\(toolCalls && toolCalls\.length\) \? "pensando"/)
    assert.doesNotMatch(trace, /kind: streaming.*sunburst/)

    assert.match(agent, /kind: reasoningStreaming && steps\.length === 0 \? "loader" : "dot"/)
    assert.match(agent, /loaderState: reasoningStreaming && steps\.length === 0 \? "pensando"/)
    assert.doesNotMatch(agent, /kind: reasoningStreaming.*sunburst/)

    assert.match(placeholder, /inferClaudeKind\(\{ label, status: "active" \}\)/)
    assert.match(placeholder, /inferLoaderState\(\{ label, status: "active" \}\)/)
  })

  it("replaces ThinkingIndicator on /chat assistant thinking surfaces", () => {
    const message = source("components/message-component.tsx")
    assert.match(message, /import \{ ThinkingStatusLoader \} from "@\/components\/thinking-status-loader"/)
    assert.doesNotMatch(message, /ThinkingIndicator/)
    assert.match(message, /state="generando-ppt"/)
    assert.match(message, /state="generando-imagen"/)
    assert.match(message, /state="cargando-general"/)
    assert.match(message, /<ThinkingTrace/)
    assert.match(message, /<ThinkingPlaceholder/)
    assert.match(message, /message\.role === 'ASSISTANT'/)
  })

  it("does not reuse the active step string as the RunTrace header label", () => {
    const steps = source("components/agentic-steps.tsx")
    const liveStart = steps.indexOf("if (isLiveActivity) {")
    const liveEnd = steps.indexOf("{liveExpanded && (", liveStart)
    const liveBlock = steps.slice(liveStart, liveEnd)
    assert.match(liveBlock, /<ThinkingStatusLoader/)
    assert.match(liveBlock, /state=\{headerState\}/)
    assert.doesNotMatch(liveBlock, /label=\{headerLabel\}/)
    assert.match(steps, /headerKitLabel/)
    assert.match(steps, /humanizeToolDetail/)
  })

  it("keeps RunTrace on the assistant bubble only, keyed by step_id", () => {
    const message = source("components/message-component.tsx")
    const steps = source("components/agentic-steps.tsx")
    const reducer = source("lib/run-trace.ts")

    assert.match(message, /if \(message\.role !== "ASSISTANT"\) return null;/)
    assert.match(steps, /shouldRenderRunTrace/)
    assert.match(steps, /if \(role && !assistantOk\) return null/)
    assert.match(reducer, /if \(role !== "ASSISTANT"\) return false/)
    assert.match(reducer, /step_id/)
    assert.match(source("lib/thinking-loaders.ts"), /step_id/)
  })
})
