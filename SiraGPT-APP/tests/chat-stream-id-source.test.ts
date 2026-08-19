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
    // safeUUID is imported from a dedicated module (lib/safe-uuid.ts) so
    // the helper is reusable across components. Verify the import exists
    // and that all generation paths call safeUUID() instead of raw
    // crypto.randomUUID().
    assert.match(
      source,
      /import \{ safeUUID \} from "\.\/safe-uuid"/,
      "chat context must import safeUUID from the dedicated module",
    )

    const outsideImport = source.replace(/import \{ safeUUID \} from "\.\/safe-uuid"/, "")
    assert.doesNotMatch(
      outsideImport,
      /=\s*crypto\.randomUUID\(\)/,
      "message send/regenerate paths must call safeUUID(); raw crypto.randomUUID() is undefined on plain HTTP LAN previews",
    )

    assert.match(
      outsideImport,
      /const requestedStreamId = [\s\S]{0,220}options\?\.streamId[\s\S]{0,220}: safeUUID\(\)/,
      "ordinary chat turns must reuse a persisted stream id and mint one safely only when absent",
    )
    assert.match(
      outsideImport,
      /const streamId = pendingMessage\?\.streamId \|\| requestedStreamId/,
      "reload retries must keep Stop ownership on the original durable stream",
    )

    const freshRegenerationStreamIds = outsideImport.match(/const streamId = safeUUID\(\)/g) || []
    assert.ok(
      freshRegenerationStreamIds.length >= 2,
      `expected regeneration paths to create stream ids through safeUUID(), found ${freshRegenerationStreamIds.length}`,
    )

    assert.doesNotMatch(source, /msg-user-\$\{Date\.now\(\)\}/,
      "optimistic user ids must not be millisecond-only values")
    assert.doesNotMatch(source, /ai-regen-\$\{Date\.now\(\)\}/,
      "regeneration placeholder ids must not be millisecond-only values")
  })
})
