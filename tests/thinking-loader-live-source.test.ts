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
    assert.match(docs, /retired for live Pensando/)
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
