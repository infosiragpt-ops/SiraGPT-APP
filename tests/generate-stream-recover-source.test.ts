import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const chatSource = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)
const apiSource = fs.readFileSync(
  path.join(process.cwd(), "lib", "api.ts"),
  "utf8",
)
const generateSource = fs.readFileSync(
  path.join(process.cwd(), "backend", "src", "routes", "ai.js"),
  "utf8",
)

describe("generate stream persist-then-poll recovery", () => {
  it("retries Safari AbortError that is not user Stop", () => {
    const start = apiSource.indexOf("} catch (error: any) {\n        lastError = error;")
    assert.ok(start >= 0)
    const block = apiSource.slice(start, start + 1600)
    assert.match(block, /if \(signal\?\.aborted\)/)
    assert.match(block, /const isBrowserAbort = error\?\.name === 'AbortError'/)
    assert.match(block, /isBrowserAbort/)
    assert.doesNotMatch(
      block.slice(0, 250),
      /if \(error\?\.name === 'AbortError' \|\| signal\?\.aborted\)/,
    )
  })

  it("polls the persisted assistant after a cut stream and only treats Stop as user abort", () => {
    assert.match(chatSource, /pollPersistedAssistantTurn/)
    assert.match(chatSource, /shouldRecoverPersistedGenerate/)
    const catchStart = chatSource.indexOf("} catch (error: any) {\n        streamFailed = true;")
    assert.ok(catchStart >= 0)
    const catchBlock = chatSource.slice(catchStart, catchStart + 2200)
    assert.match(
      catchBlock,
      /if \(controller\.signal\.aborted \|\| pendingStopsRef\.current\.has\(activeChat\.id\)\)/,
    )
    assert.doesNotMatch(
      catchBlock.slice(0, 400),
      /if \(controller\.signal\.aborted \|\| error\?\.name === 'AbortError'\)/,
    )
    assert.match(catchBlock, /shouldRecoverPersistedGenerate\(error/)
  })

  it("treats duplicate_turn_replay and start+empty [DONE] as a finished turn", () => {
    assert.match(apiSource, /type === 'duplicate_turn_replay'/)
    assert.match(apiSource, /finishedPersistedTurn/)
    assert.match(apiSource, /sawStartEvent/)
    assert.match(apiSource, /recoverPersistedGenerateContent/)
    assert.match(apiSource, /generateStreamFlights\.joinOrRun/)
    assert.match(apiSource, /VIDEO_TEXT_GENERATE_ERROR_ES/)
    const doneHandler = apiSource.slice(
      apiSource.indexOf("if (payload === '[DONE]')"),
      apiSource.indexOf("if (payload === '[DONE]')") + 2200,
    )
    assert.match(doneHandler, /shouldFinishPersistedTurn/)
    assert.match(doneHandler, /recoverPersistedGenerateContent/)
  })

  it("emits [DONE] from generate finally when persist finished", () => {
    const idx = generateSource.indexOf("Safari/Cloudflare can drop the socket after persist")
    assert.ok(idx > 0, "generate finally must mention Safari persist-then-poll")
    const block = generateSource.slice(idx, idx + 700)
    assert.match(block, /data: \[DONE\]/)
    assert.match(block, /streamCompleted/)
    assert.match(block, /clientGone/)
  })
})
