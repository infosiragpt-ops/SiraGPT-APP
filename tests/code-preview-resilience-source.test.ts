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
    assert.match(runApp, /if \(!isCurrentRun\(\)\) return/)
    assert.match(previewSource, /previewRunGenerationRef\.current !== generation/)
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
})
