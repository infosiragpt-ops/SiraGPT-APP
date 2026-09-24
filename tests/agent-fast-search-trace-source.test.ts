import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8")

test("web_search tool_result carries the Búsqueda rápida summary end to end", () => {
  const api = read("lib/api.ts")
  assert.match(api, /search\?: AgentSearchSummary/)
  assert.match(api, /export type AgentSearchSummary = \{[\s\S]*latencyMs\?: number[\s\S]*sources: Array<\{ title\?: string; url: string \}>/)

  const ctx = read("lib/chat-context-integrated.tsx")
  assert.match(ctx, /\.\.\.\(event\.search \? \{ search: event\.search \} : \{\}\)/, "tool_result must keep the search summary on the step")

  const history = read("components/message-component.tsx")
  assert.match(history, /s\.search && typeof s\.search === 'object' \? \{ search: s\.search \} : \{\}/, "hydrated history keeps source chips")
})

test("agent trace renders «N fuentes · 180 ms» and favicon source chips for finished searches", () => {
  const trace = read("components/agent-trace.tsx")
  assert.match(trace, /export function searchMetaLabel/)
  assert.match(trace, /"fuente" : "fuentes"/)
  assert.match(trace, /status === "done" && step\.search/)

  const timeline = read("components/claude-thinking-timeline.tsx")
  assert.match(timeline, /meta\?: string/)
  assert.match(timeline, /sources\?: Array<\{ title\?: string; url: string \}>/)
  assert.match(timeline, /function StepSources/)
  assert.match(timeline, /data-step-sources="1"/)
  assert.match(timeline, /rel="noopener noreferrer"/)
  assert.match(timeline, /\{!elapsed && step\.meta \?/)
})
