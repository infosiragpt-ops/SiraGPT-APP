import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const chatSource = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const previewSource = readFileSync("components/code/preview-pane.tsx", "utf8")

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("code preview resilience", () => {
  it("forgets stale remote project links before applying a local fallback", () => {
    const detach = sliceBetween(
      chatSource,
      "const detachCodexProjectForLocalFallback = React.useCallback(",
      "// Keep the module-level active-codex-project",
    )
    const codexEngine = sliceBetween(
      chatSource,
      "const runCodexEngine = React.useCallback(",
      "const dispatch = React.useCallback(",
    )

    assert.match(detach, /delete codexProjectRef\.current\[sid\]/)
    assert.match(detach, /clearSessionCodexProject\(sid\)/)
    assert.match(detach, /clearWorkspaceCodexProject\(activeFolder\.id\)/)
    assert.match(detach, /setActiveCodexProject\(null\)/)
    assert.equal(
      codexEngine.match(/detachCodexProjectForLocalFallback\(sid\)/g)?.length,
      2,
      "both Codex fallback paths must detach the stale remote preview",
    )
  })

  it("keeps a renderable static preview visible during a cold dev-server start", () => {
    assert.match(
      previewSource,
      /liveRun\.phase === "starting" && canRenderStaticPreview/,
    )
    assert.match(previewSource, /\{staticPreviewFrame\}/)
    assert.match(previewSource, /Preparando la versión completa/)
  })

  it("invalidates and aborts a pending preview start when the user stops it", () => {
    const stopApp = sliceBetween(
      previewSource,
      "const stopApp = React.useCallback(",
      "// While the app is live",
    )
    const runApp = sliceBetween(
      previewSource,
      "const runApp = React.useCallback(",
      "// Mirror the latest values into refs",
    )

    assert.match(stopApp, /previewRunGenerationRef\.current \+= 1/)
    assert.match(stopApp, /previewStartAbortRef\.current\?\.abort\(\)/)
    assert.match(stopApp, /pendingAutoRunRef\.current = false/)
    assert.match(stopApp, /forceAutoRunRef\.current = false/)
    assert.match(runApp, /const isCurrentRun = \(\) =>/)
    assert.match(
      runApp,
      /codexApi\.startPreview\(codexProjectId,\s*startController\.signal\)/,
    )
    assert.match(runApp, /startPreviewWithCleanupFence\(/)
    assert.match(runApp, /cleanup: \(\) => codexApi\.stopPreview\(codexProjectId\)/)
    assert.match(runApp, /if \(fencedStart\.stale\) return/)
    assert.match(previewSource, /previewRunGenerationRef\.current === generation/)
  })

  it("compensates every runner start that settles after its UI generation went stale", () => {
    const runApp = sliceBetween(
      previewSource,
      "const runApp = React.useCallback(",
      "// Mirror the latest values into refs",
    )

    assert.equal(
      runApp.match(/startPreviewWithCleanupFence\(/g)?.length,
      3,
      "GitHub, Codex and host starts must all own a post-settle cleanup fence",
    )
    assert.match(runApp, /cleanup: \(\) => githubService\.stop\(boundRepo\)/)
    assert.match(runApp, /cleanup: \(\) => codexApi\.stopPreview\(codexProjectId\)/)
    assert.match(runApp, /cleanup: \(\) => hostRunnerService\.stop\(hostRunId\)/)
    assert.equal(
      runApp.match(/shouldCleanupStalePreviewStart\(/g)?.length,
      3,
      "each shared runner resource must protect a newer generation lease",
    )
  })

  it("serializes readiness and heartbeat polling so slow requests still progress", () => {
    const polling = sliceBetween(
      previewSource,
      "const startReadyHeartbeat = React.useCallback(",
      "const runApp = React.useCallback",
    )

    assert.equal(
      polling.match(/startSerializedPreviewPoll\(/g)?.length,
      2,
      "readiness and heartbeat need independent serialized loops",
    )
    assert.doesNotMatch(polling, /setInterval\(async/)
  })

  it("bounds each readiness generation by wall clock and cancels slow status reads", () => {
    const polling = sliceBetween(
      previewSource,
      "const startReadyHeartbeat = React.useCallback(",
      "const runApp = React.useCallback",
    )

    assert.match(previewSource, /const PREVIEW_READY_DEADLINE_MS = 200_000/)
    assert.match(polling, /Date\.now\(\) \+ PREVIEW_READY_DEADLINE_MS/)
    assert.match(polling, /read: async \(signal\)/)
    assert.match(polling, /return statusFn\(signal\)/)
    assert.match(polling, /deadlineAtMs: readinessDeadlineAtMs/)
    assert.match(polling, /onDeadline: finishTimedOut/)
    assert.match(polling, /onError: \(\) => \{[\s\S]*Date\.now\(\) < readinessDeadlineAtMs[\s\S]*return false/)
    assert.match(previewSource, /githubService\.runStatus\(boundRepo, signal\)/)
    assert.match(previewSource, /codexApi\.previewStatus\(codexProjectId, signal\)/)
    assert.match(previewSource, /hostRunnerService\.status\(runIdRef\.current, signal\)/)
  })

  it("stops the owning Codex preview when the pane unmounts", () => {
    const runApp = sliceBetween(
      previewSource,
      "const runApp = React.useCallback(",
      "// Mirror the latest values into refs",
    )
    const lifecycle = sliceBetween(
      previewSource,
      "// Lifecycle cleanup: stop the dev server",
      "// Debounce rebuilds so typing stays smooth",
    )

    assert.match(runApp, /codexPreviewProjectIdRef\.current = codexProjectId/)
    assert.match(lifecycle, /const mode = modeRef\.current/)
    assert.match(
      lifecycle,
      /codexPreviewProjectIdRef\.current \|\| getActiveCodexProject\(\)/,
    )
    assert.match(lifecycle, /codexApi\.stopPreview\(codexProjectId\)/)
    assert.match(lifecycle, /previewOwnerGeneration !== generation/)
    assert.match(lifecycle, /window\.setTimeout\(\(\) => \{/)
  })

  it("auto-retries against the Codex runner when its project link rehydrates after mount", () => {
    assert.match(previewSource, /CODE_ACTIVE_CODEX_PROJECT_EVENT/)
    assert.match(
      previewSource,
      /const \[activeCodexProjectId, setActiveCodexProjectIdState\] = React\.useState/,
    )
    assert.match(
      previewSource,
      /window\.addEventListener\(CODE_ACTIVE_CODEX_PROJECT_EVENT, refreshCodexProject\)/,
    )
    assert.match(
      previewSource,
      /gitBinding \|\| activeCodexProjectId \|\| "workspace"/,
      "the dedupe signature must change when the remote project becomes available",
    )
    assert.match(
      previewSource,
      /const codexProjectId = activeCodexProjectId \|\| getActiveCodexProject\(\)/,
    )
    assert.match(
      previewSource,
      /\[activeCodexProjectId, autoRunSignal, canRunProject, projectSignature\]/,
      "the post-mount auto-run gate must react to Codex project rehydration",
    )
  })

  it("treats a Codex-only workspace as runnable from the manual Run event", () => {
    assert.match(
      previewSource,
      /Boolean\(getGitBinding\(activeFolderIdRef\.current\)\) \|\|\s*Boolean\(getActiveCodexProject\(\)\)/,
    )
  })

  it("honors a forced preview restart from the composer apply event", () => {
    assert.match(previewSource, /window\.addEventListener\(CODE_RUN_PREVIEW_EVENT, onQueuedPreviewRun\)/)
    assert.match(previewSource, /if \(detail\?\.force\) forceAutoRunRef\.current = true/)
  })
})
