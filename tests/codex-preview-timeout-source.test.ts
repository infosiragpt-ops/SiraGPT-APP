import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const source = [
  readFileSync("lib/codex/api/core.ts", "utf8"),
  readFileSync("lib/codex/api/projects.ts", "utf8"),
].join("\n")

describe("Codex preview startup timeout", () => {
  it("allows the backend's bounded 90-second cold-start window to finish", () => {
    const start = source.indexOf("startPreview:")
    const end = source.indexOf("previewStatus:", start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)

    const startPreview = source.slice(start, end)
    assert.match(startPreview, /timeoutMs:\s*110_000/)
    assert.match(startPreview, /startPreview:\s*\(id:\s*string,\s*signal\?:\s*AbortSignal\)/)
    assert.match(startPreview, /\{\s*method:\s*"POST",\s*timeoutMs:\s*110_000,\s*signal\s*\}/)
  })

  it("combines caller cancellation with the hard request deadline", () => {
    assert.match(source, /function boundedRequestSignal\(/)
    assert.match(source, /anySignal\(\[externalSignal,\s*timeoutSignal\]\)/)
    assert.match(source, /signal:\s*boundedRequestSignal\(requestInit\.signal,\s*timeoutMs\)/)
  })
})
