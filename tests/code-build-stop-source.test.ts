import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const panel = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const intake = readFileSync("lib/builder/intake-service.ts", "utf8")
const opencodeClient = readFileSync("lib/opencode/opencode-service.ts", "utf8")
const opencodeRoute = readFileSync("backend/src/routes/opencode.js", "utf8")

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("code build Stop honors the in-flight builder", () => {
  it("buildApp owns an AbortController and never applies files after Detener", () => {
    const buildApp = sliceBetween(
      panel,
      "const buildApp = React.useCallback(",
      "const runDeterministicSRE = React.useCallback(",
    )

    assert.match(buildApp, /const controller = new AbortController\(\)/)
    assert.match(buildApp, /abortRef\.current = controller/)
    assert.match(buildApp, /await intakeService\.generate\(text,\s*controller\.signal\)/)
    assert.match(buildApp, /const cancelledTurn = \(\) => controller\.signal\.aborted \|\| abortRef\.current !== controller/)
    assert.match(buildApp, /if \(cancelledTurn\(\)\) \{\s*finishStopped\(\)\s*return/)
    assert.match(
      buildApp,
      /if \(abortRef\.current === controller\) \{\s*abortRef\.current = null\s*setBuildingApp\(false\)/,
    )
    const generateCatch = buildApp.slice(buildApp.indexOf("await intakeService.generate(text, controller.signal)"))
    const cancelInCatch = generateCatch.indexOf("if (cancelledTurn())")
    const fallbackInCatch = generateCatch.indexOf("buildLocalIndexFallbackFiles(text, ctx)")
    assert.ok(
      cancelInCatch !== -1 && fallbackInCatch !== -1 && cancelInCatch < fallbackInCatch,
      "an abort must be checked before the local shell fallback can apply files",
    )
  })

  it("the builder fetch aborts when either the caller or the 120s timeout fires", () => {
    assert.match(intake, /function composeAbortSignals\(/)
    assert.match(intake, /const composite = signal \? composeAbortSignals\(signal, timeout\) : timeout/)
    assert.match(intake, /a\.addEventListener\("abort", onAbort/)
  })

  it("in-turn deterministic fallbacks pass the live abort signal into generate", () => {
    const fallback = sliceBetween(
      panel,
      "const runDeterministicPromptInto = React.useCallback(",
      "const runDeterministicInto = React.useCallback(",
    )
    assert.match(fallback, /await intakeService\.generate\(prompt,\s*signal\)/)
    assert.match(panel, /runDeterministicInto\(ctx, cancelledTurn, controller\.signal\)/)
    assert.match(panel, /runDeterministicPromptInto\(\s*text,\s*\{\s*goal: "app", productType: text \},\s*cancelledTurn,\s*controller\.signal,/)
  })
})

describe("code OpenCode Stop aborts the engine session", () => {
  it("exposes a frontend abortSession that POSTs /session/:id/abort", () => {
    assert.match(opencodeClient, /async abortSession\(sessionId: string\)/)
    assert.match(opencodeClient, /\/session\/\$\{encodeURIComponent\(sessionId\)\}\/abort/)
  })

  it("the backend route and client forward abort to SiraCode", () => {
    assert.match(opencodeRoute, /router\.post\('\/session\/:id\/abort'/)
    assert.match(opencodeRoute, /siraCode\.abort\(req\.params\.id/)
    assert.doesNotMatch(opencodeRoute, /createOpencodeClient\(\)/)
  })

  it("Detener and session teardown abort the live OpenCode session", () => {
    const cancelStream = sliceBetween(
      panel,
      "const cancelStream = React.useCallback(() => {",
      "const sendPrompt = React.useCallback(",
    )
    assert.match(cancelStream, /opencodeService\.abortSession\(engineSession\)/)
    assert.match(panel, /return \(\) => \{[\s\S]*opencodeService\.abortSession\(engineSession\)/)
    assert.match(
      panel,
      /if \(stoppedByUser\) \{\s*void opencodeService\.abortSession\(esid\)/,
    )
  })

  it("the OpenCode cancelledTurn predicate includes the abort signal", () => {
    const runEngine = sliceBetween(
      panel,
      "const runEngine = React.useCallback(",
      "const runCodexEngine = React.useCallback(",
    )
    assert.match(
      runEngine,
      /const cancelledTurn = \(\) => controller\.signal\.aborted \|\| abortRef\.current !== controller/,
    )
  })
})

describe("code work_task Stop does not continue the plan", () => {
  it("propagates a cancelled flag from sendPrompt and engines", () => {
    assert.match(panel, /cancelled = true/)
    assert.match(panel, /cancelled: cancelled \|\| controller\.signal\.aborted/)
    assert.match(panel, /return "cancelled"/)
  })

  it("blocks the current task and idles instead of completing an empty apply", () => {
    const workTask = sliceBetween(panel, 'case "work_task": {', 'case "patch": {')
    assert.match(workTask, /if \(promptResult\?\.cancelled\)/)
    assert.match(workTask, /if \(out === "cancelled"\)/)
    assert.match(workTask, /status: cancelledWork \|\| !lastVerdict\.ok \? "blocked" : "completed"/)
    assert.match(workTask, /phase: cancelledWork \? "idle" : lastVerdict\.ok \? "preview" : "debugging"/)
  })
})
