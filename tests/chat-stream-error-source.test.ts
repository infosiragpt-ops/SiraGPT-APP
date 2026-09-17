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
    const errorStart = source.indexOf('(error) => {\n              streamFailed = true')
    const errorEnd = source.indexOf('            controller.signal,', errorStart)
    assert.ok(
      errorStart >= 0 && errorEnd > errorStart,
      "default chat stream error callback must exist",
    )
    const errorBlock = source.slice(errorStart, errorEnd)

    assert.match(errorBlock, /fgBuffer\.flush\(\)/)
    assert.match(errorBlock, /bg\.fail\(activeChat\.id/)
    assert.match(errorBlock, /streamFailed = true/,
      "the error callback must mark the turn failed before returning")
    assert.doesNotMatch(errorBlock, /content:\s*["']{2}/,
      "the error path must not erase the streamed assistant tail")
    assert.doesNotMatch(errorBlock, /clearPending\(/,
      "the error callback must retain pending storage for retry")
    assert.doesNotMatch(errorBlock, /bg\.complete\(/,
      "the error callback must not mark the background stream done")

    assert.match(
      source,
      /waitsForDefaultStreamTerminal && !terminalSucceeded && !userStopped && !streamFailed/,
      "a generate 503 / streamFailed turn must not poll getChat and keep Pensando",
    )

    const successStart = source.indexOf('// Synchronous intent endpoints are terminal')
    const successEnd = source.indexOf('      } catch (error: any) {', successStart)
    assert.ok(successStart >= 0 && successEnd > successStart)
    const successBlock = source.slice(successStart, successEnd)
    assert.match(successBlock, /if \(terminalSucceeded\) \{\s*clearThisPendingTurn\(\)/,
      "pending storage may only clear after a successful turn")

    const finallyStart = source.indexOf('      } finally {', successEnd)
    const finallyEnd = source.indexOf('      }\n    },', finallyStart)
    assert.ok(finallyStart >= 0 && finallyEnd > finallyStart)
    const finallyBlock = source.slice(finallyStart, finallyEnd)
    assert.match(finallyBlock, /markChatIdle\(activeChat\.id, streamId\)/,
      "a failed stream must release the active-stream guard")
    assert.match(finallyBlock, /if \(!streamFailed && terminalSucceeded\) \{\s*bg\.complete\(activeChat\.id\)/,
      "finally must not convert a failed background stream into done")
  })
})
