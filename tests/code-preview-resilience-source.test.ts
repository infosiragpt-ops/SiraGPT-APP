import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("code preview resilience", () => {

  it("threads AbortSignal into GitHub and host runner starts", () => {
    const github = readFileSync("lib/github-service.ts", "utf8")
    assert.match(
      github,
      /run: \(id: string, env\?: Record<string, string>, signal\?: AbortSignal\)/,
    )
    assert.match(github, /send<RunStatus & \{ ok: boolean \}>\(\s*"POST",\s*`\/connected\/\$\{id\}\/run`,\s*env \? \{ env \} : undefined,\s*signal,?\s*\)/)
  })
})
