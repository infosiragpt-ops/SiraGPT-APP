import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const providerPath = path.join(process.cwd(), "lib", "chat-context-integrated.tsx")
const source = fs.readFileSync(providerPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("chat stream id source contract", () => {
  it("uses a LAN-safe UUID helper instead of raw crypto.randomUUID for chat stream ids", () => {
    const helper = sliceBetween(
      "function safeUUID(): string {",
      "// Helper function to check if error is related to monthly API limit",
    )

    assert.match(helper, /crypto\.randomUUID/, "helper should use native randomUUID when it is available")
    assert.match(helper, /crypto\.getRandomValues/, "helper must fall back to getRandomValues for insecure LAN HTTP contexts")
    assert.match(helper, /Math\.random/, "helper must keep a last-resort fallback so sending never leaves an empty assistant placeholder")

    const outsideHelper = source.replace(helper, "")
    assert.doesNotMatch(
      outsideHelper,
      /=\s*crypto\.randomUUID\(\)/,
      "message send/regenerate paths must call safeUUID(); raw crypto.randomUUID() is undefined on plain HTTP LAN previews",
    )

    const streamIdCalls = outsideHelper.match(/const streamId = safeUUID\(\)/g) || []
    assert.ok(
      streamIdCalls.length >= 3,
      `expected all chat generation paths to create stream ids through safeUUID(), found ${streamIdCalls.length}`,
    )
  })
})
