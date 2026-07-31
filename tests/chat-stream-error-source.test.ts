import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)

describe("chat stream error preservation contract", () => {
  it("keeps the pending draft and streamed assistant tail visible after failure", () => {
    const start = source.indexOf('console.error("Streaming failed:", error)')
    const end = source.indexOf('      } finally {', start)
    assert.ok(start >= 0 && end > start, "default chat stream error block must exist")
    const block = source.slice(start, end)

    assert.match(block, /fgBuffer\.flush\(\)/)
    assert.match(block, /bg\.fail\(activeChat\.id/)
    assert.doesNotMatch(block, /clearPending\(/,
      "failed sends must remain in pending storage for retry")
    assert.doesNotMatch(block, /content:\s*["']{2}/,
      "the error path must not erase the streamed assistant tail")
    assert.match(block, /markChatIdle\(activeChat\.id, streamId\)/,
      "a failed stream must release the active-stream guard without clearing pending")
  })
})
