import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "components", "chat-interface-enhanced.tsx")
const source = fs.readFileSync(componentPath, "utf8")
const agenticStepsPath = path.join(process.cwd(), "components", "agentic-steps.tsx")
const agenticStepsSource = fs.readFileSync(agenticStepsPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string, haystack = source): string {
  const start = haystack.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = haystack.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return haystack.slice(start, end)
}

describe("chat agentic loop routing source contract", () => {
  it("routes deterministic research/search prompts into the visible agent loop before normal chat placeholders", () => {
    assert.match(
      source,
      /import \{[^}]*classifyIntentFastPath[^}]*\} from "@\/lib\/ai-service"/,
      "the composer must use the shared deterministic intent helper instead of a local keyword fork",
    )

    const deterministicBranch = sliceBetween(
      "const deterministicAgenticIntent = classifyIntentFastPath(msg);",
      "if (sendInFlightRef.current) return;",
    )

    assert.match(
      deterministicBranch,
      /\['web_search', 'agent_task', 'math', 'viz', 'chart', 'ppt'\]\.includes\(deterministicAgenticIntent\)/,
      "research/search and durable tool intents should short-circuit into the agent task surface",
    )
    assert.match(
      deterministicBranch,
      /await handleAgentTask\(msg, filesToSend, \{ userMessageAlreadyAdded: false \}\);/,
      "the deterministic fast path must start the agent loop directly, before the normal text stream placeholder",
    )
  })

  it("reuses existing optimistic messages when async classification chooses the agent route", () => {
    const helper = sliceBetween(
      "const runClassifiedAgentTask = () => handleAgentTask(msg, filesToSend, {",
      "switch (intent)",
    )
    assert.match(helper, /userMessageAlreadyAdded: !isNewChat/)
    assert.match(helper, /assistantMessageId: !isNewChat \? assistantPlaceholder\.id : undefined/)

    const switchBlock = sliceBetween("switch (intent) {", "    } catch (err: any) {")
    for (const marker of ["case 'ppt':", "case 'web_search':", "case 'agent_task':"]) {
      const caseStart = switchBlock.indexOf(marker)
      assert.notEqual(caseStart, -1, `missing ${marker}`)
      const caseSlice = switchBlock.slice(caseStart, switchBlock.indexOf("break;", caseStart))
      assert.match(caseSlice, /await runClassifiedAgentTask\(\);/)
      assert.doesNotMatch(caseSlice, /await handleAgentTask\(msg, filesToSend\);/)
    }
  })

  it("seeds the agent bubble with a visible planning step before backend events arrive", () => {
    const handler = sliceBetween(
      "const clientBootstrapStepId = 'client-agent-bootstrap';",
      "for await (const evt of agentTaskService.runIterator({",
    )

    assert.match(handler, /label: 'Analizando solicitud'/)
    assert.match(handler, /reasoning: 'Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea\.'/)
    assert.match(handler, /status: 'running'/)
    assert.match(handler, /const initialTaskState = makeInitialTaskState\(\);/)
    assert.match(handler, /let state: AgentTaskState = makeInitialTaskState\(\);/)

    const eventLoop = sliceBetween(
      "for await (const evt of agentTaskService.runIterator({",
      "        // Stream closed cleanly",
    )
    assert.match(eventLoop, /eventType === 'step_start'/)
    assert.match(eventLoop, /state = settleClientBootstrapStep\(state\);/)
  })

  it("renders the agent loop as a minimal professional activity card", () => {
    const liveBlock = sliceBetween(
      "if (isLiveActivity) {",
      "  return (",
      agenticStepsSource,
    )
    // The live-activity header comment evolved ("Minimal live activity" →
    // "Claude-style live activity"); anchor on the stable phrase.
    assert.match(liveBlock, /live activity/)
    assert.match(agenticStepsSource, /aria-label="Agente trabajando"/)
    assert.match(agenticStepsSource, /Trabajando/)
    // The AgentProgressBeam bar was replaced by the Claude-style shimmer
    // line + circular spinner (feat: minimal thinking-stream indicator).
    assert.match(agenticStepsSource, /DotmCircular15|AgentProgressBeam/)
    assert.match(agenticStepsSource, /thinking-shimmer-text/)
    assert.match(agenticStepsSource, /rounded-2xl border border-border\//)
  })

  it("keeps reloaded empty agent states visible instead of collapsing to a plain spinner", () => {
    const projection = sliceBetween(
      "function projectTimelineSteps",
      "const projected",
      agenticStepsSource,
    )
    assert.match(projection, /label: "Analizando solicitud"/)
    assert.match(projection, /reasoning: "Preparando el plan, las fuentes y las herramientas antes de ejecutar la tarea\."/)
  })
})
