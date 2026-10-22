import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
const intake = readFileSync("lib/builder/intake-service.ts", "utf8")
const opencodeRoute = readFileSync("backend/src/routes/opencode.js", "utf8")

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("code build Stop honors the in-flight builder", () => {

  it("the builder fetch aborts when either the caller or the 120s timeout fires", () => {
    assert.match(intake, /function composeAbortSignals\(/)
    assert.match(intake, /const composite = signal \? composeAbortSignals\(signal, timeout\) : timeout/)
    assert.match(intake, /a\.addEventListener\("abort", onAbort/)
  })
})

describe("code OpenCode Stop aborts the engine session", () => {

  it("the backend route and client forward abort to SiraCode", () => {
    assert.match(opencodeRoute, /router\.post\('\/session\/:id\/abort'/)
    assert.match(opencodeRoute, /siraCode\.abort\(req\.params\.id/)
    assert.doesNotMatch(opencodeRoute, /createOpencodeClient\(\)/)
  })
})
