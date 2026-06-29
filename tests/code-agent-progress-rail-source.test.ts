import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

import { buildWriteMetrics } from "../lib/code-chat-metrics"

// Guards the /code 5-step progress rail (Plan → Contexto → Generar → Aplicar →
// Verificar) + the Worked Summary against a silent merge drop. The rail is
// driven entirely by per-turn state (agentPhases/agentLabel/actions/metrics) set
// inline across sendPrompt/buildApp in components/code/ai-code-chat-panel.tsx
// and rendered by CodeAgentProgress. Taking the origin side of a conflict can
// strip that wiring while typecheck + a smoke boot still pass green, so these
// assertions fail loudly if the inline wiring or the render path disappears.

const componentPath = path.join(process.cwd(), "components", "code", "ai-code-chat-panel.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

const sendPrompt = () =>
  sliceBetween("const sendPrompt = React.useCallback(", "const buildApp = React.useCallback(")
const buildApp = () =>
  sliceBetween("const buildApp = React.useCallback(", "const runDeterministicSRE = React.useCallback(")

describe("code-agent progress rail — Worked Summary data (behavioral)", () => {
  it("a completed file-writing turn produces a non-empty Worked Summary (actions + metrics)", () => {
    const startedAt = 1_000
    const { actions, metrics } = buildWriteMetrics(
      [
        { path: "app/page.tsx", content: "line1\nline2\nline3\n" },
        { path: "lib/db.ts", content: "export const db = 1\n" },
      ],
      {
        startedAt,
        now: startedAt + 4_200,
        getPrevContent: () => "",
      },
    )

    assert.ok(actions.length > 0, "a turn that wrote files must yield a non-empty action log")
    assert.equal(metrics.filesChanged, 2, "metrics must count the real files written")
    assert.ok(metrics.linesAdded > 0, "new files must report added lines in the Worked Summary")
    assert.ok(metrics.timeWorkedMs > 0, "the Worked Summary must report measured wall-clock time")
    assert.ok(metrics.actionsCount > 0, "actionsCount must be non-zero for a turn that did work")
  })
})

describe("code-agent progress rail — verify phase is the terminal step", () => {
  it("the phase blueprint ends on the 'verify' step the rail must reach", () => {
    const blueprint = sliceBetween("const CODE_AGENT_PHASE_BLUEPRINT = [", "] as const")
    for (const key of ["plan", "context", "generate", "apply", "verify"]) {
      assert.match(blueprint, new RegExp(`key: "${key}"`), `phase blueprint must keep the "${key}" step`)
    }
    const verifyIndex = blueprint.indexOf('key: "verify"')
    const applyIndex = blueprint.indexOf('key: "apply"')
    assert.ok(
      verifyIndex > applyIndex && applyIndex !== -1,
      "'verify' must remain the final phase after 'apply' so a completed turn reaches the end of the rail",
    )
  })
})

describe("code-agent progress rail — buildApp inline wiring", () => {
  it("the buildApp success path sets agentPhases reaching the done 'verify' step", () => {
    const fn = buildApp()
    assert.match(
      fn,
      /agentPhases: buildCodeAgentPhases\("verify"/,
      "buildApp success must populate the rail through buildCodeAgentPhases(\"verify\", …)",
    )
    assert.match(
      fn,
      /verify:\s*\{\s*status:\s*"done"/,
      "the buildApp verify phase must land on status 'done' so the rail shows completion",
    )
  })

  it("the buildApp success path attaches a Worked Summary (actions + metrics)", () => {
    const fn = buildApp()
    assert.match(
      fn,
      /const \{ actions, metrics \} = buildWriteMetrics\(/,
      "buildApp must compute real actions + metrics via buildWriteMetrics",
    )
    const successWiring = sliceBetween(
      'agentLabel: "App construida"',
      "} catch (err: any) {",
    )
    assert.match(successWiring, /\bactions,/, "the completed buildApp turn must carry the actions log")
    assert.match(successWiring, /\bmetrics,/, "the completed buildApp turn must carry the metrics (Worked Summary)")
  })

  it("the deterministic APPS build path writes a self-contained index.html preview", () => {
    const fn = buildApp()
    assert.match(
      fn,
      /await intakeService\.generate\(text\)/,
      "buildApp must use the backend builder that returns index.html for APPS",
    )
    assert.match(
      fn,
      /buildLocalIndexFallbackFiles\(text, ctx\)/,
      "buildApp must fall back to a local index.html when the backend builder is unavailable",
    )
    assert.match(
      fn,
      /localhost \/ index\.html/,
      "the user-facing completion must make the preview target explicit",
    )
    assert.doesNotMatch(
      fn,
      /buildViteLandingFiles/,
      "the primary APPS path must not switch landing prompts to a runner-gated Vite project",
    )
  })
})

describe("code-agent progress rail — sendPrompt inline wiring", () => {
  it("the sendPrompt completion path sets agentPhases reaching the done 'verify' step", () => {
    const fn = sendPrompt()
    assert.match(
      fn,
      /agentLabel: "Turno completado"/,
      "sendPrompt must mark the completed turn so the live label renders",
    )
    assert.match(
      fn,
      /agentPhases: buildCodeAgentPhases\("verify"/,
      "sendPrompt completion must populate the rail through buildCodeAgentPhases(\"verify\", …)",
    )
    assert.match(
      fn,
      /verify:\s*\{\s*status:\s*"done"/,
      "the sendPrompt verify phase must land on status 'done' so the rail shows completion",
    )
  })

  it("the sendPrompt completion path attaches a Worked Summary (actions + metrics)", () => {
    const fn = sendPrompt()
    assert.match(
      fn,
      /const \{ actions, metrics \} = buildWriteMetrics\(/,
      "sendPrompt must compute real actions + metrics via buildWriteMetrics",
    )
    assert.match(
      fn,
      /actions: effectiveActions,/,
      "the completed sendPrompt turn must carry the actions log",
    )
    assert.match(
      fn,
      /metrics: withUsage,/,
      "the completed sendPrompt turn must carry the metrics (Worked Summary)",
    )
  })
})

describe("code-agent progress rail — render path", () => {
  it("computes liveAgentLabel from the turn's agentLabel", () => {
    assert.match(
      source,
      /const liveAgentLabel = [^\n]*turn\.agentLabel/,
      "the render must derive liveAgentLabel from turn.agentLabel (plus the streaming/plan fallbacks)",
    )
  })

  it("renders CodeAgentProgress fed by the turn's agentPhases", () => {
    assert.match(
      source,
      /<CodeAgentProgress phases=\{turn\.agentPhases\} \/>/,
      "the assistant turn must render <CodeAgentProgress phases={turn.agentPhases} />",
    )
    assert.match(
      source,
      /\{turn\.actions && turn\.actions\.length > 0 \? <ChatActionLog/,
      "the assistant turn must render the action log when the turn has actions",
    )
    assert.match(
      source,
      /\{turn\.metrics \? <ChatWorkedSummary/,
      "the assistant turn must render the Worked Summary when the turn has metrics",
    )
  })

  it("CodeAgentProgress renders nothing without phases but maps them when present", () => {
    const comp = sliceBetween(
      "function CodeAgentProgress({ phases }: { phases?: CodeAgentPhase[] }) {",
      "function ChatActionLog",
    )
    assert.match(
      comp,
      /if \(!phases \|\| phases\.length === 0\) return null/,
      "CodeAgentProgress must short-circuit to null for turns that never set agentPhases",
    )
    assert.match(
      comp,
      /phases\.map\(\(phase\)/,
      "CodeAgentProgress must map each phase into the rail",
    )
  })
})
