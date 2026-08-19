import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("Codex deterministic fallback", () => {
  it("applies fallback files inside the existing engine turn", () => {
    const runCodexEngine = sliceBetween(
      "const runCodexEngine = React.useCallback(",
      "const dispatch = React.useCallback(",
    )

    assert.doesNotMatch(
      runCodexEngine,
      /await buildApp\(/,
      "buildApp refuses to start while the Codex turn owns busy=true",
    )
    assert.ok(
      runCodexEngine.match(/await runDeterministicPromptInto\(/g)?.length === 2,
      "both the no-files and thrown-error paths must run the in-turn fallback",
    )
    assert.match(
      runCodexEngine,
      /\{\s*written:\s*fallbackFiles\s*\}/,
      "the completed Codex turn must report and retain the files it actually applied",
    )
    assert.match(
      runCodexEngine,
      /detachCodexProjectForLocalFallback\(sid\)[\s\S]*?await runDeterministicPromptInto\(/,
      "a local fallback must not be hidden behind a stale remote Codex preview",
    )
  })

  it("checks cancellation before applying a late fallback", () => {
    const fallback = sliceBetween(
      "const runDeterministicPromptInto = React.useCallback(",
      "const runDeterministicInto = React.useCallback(",
    )

    assert.match(fallback, /const throwIfCancelled = \(\) =>/)
    assert.match(fallback, /throwIfCancelled\(\)\s*applyFilesToWorkspace\(files\)/)
    assert.match(fallback, /throwIfCancelled\(\)\s*applyFilesToWorkspace\(fallback\)/)
  })
})
