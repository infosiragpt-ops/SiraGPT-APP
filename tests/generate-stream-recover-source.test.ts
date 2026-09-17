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
    assert.match(apiSource, /readWithIdle/)
    assert.match(apiSource, /GENERATE_STREAM_IDLE_MS/)
    assert.match(apiSource, /GENERATE_STREAM_CONNECT_MS/)
    assert.match(apiSource, /shouldRetryGenerateHttp/)
    assert.match(apiSource, /attachGenerateHttpError/)
    assert.match(apiSource, /canResume \? 'resuming' : 'reconnecting'/)
    assert.match(apiSource, /tryRecoverPersistedTurn/)
    assert.match(apiSource, /decideEmptyGenerateStreamAction/)
    assert.match(apiSource, /isSseKeepaliveComment/)
    assert.match(apiSource, /shouldRecoverOnKeepalive/)
    assert.match(apiSource, /text_delta/)
    assert.match(chatSource, /tryRecoverPersistedTurn: recoverPersistedTurnNow/)
    assert.match(chatSource, /shouldPollPersistedTurnOnStreamClose/)
    assert.match(chatSource, /delayMs: 0/)
    assert.doesNotMatch(
      chatSource,
      /if \(!prev \|\| prev\.id !== activeChat\.id \|\| activeStreamingChatIdsRef\.current\.has\(activeChat\.id\)\) return prev;/,
    )
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

  it("asks for the persisted reply before spending reconnect slots and never resumes a stale cursor", () => {
    const start = apiSource.indexOf("} catch (error: any) {\n        lastError = error;")
    assert.ok(start >= 0)
    const block = apiSource.slice(start, start + 2600)
    assert.match(
      block,
      /if \(isNetworkError && !hasDeliveredAnyContent && options\.tryRecoverPersistedTurn\)/,
      "a transport cut with nothing painted must poll the persisted turn before reconnecting",
    )
    assert.doesNotMatch(
      apiSource,
      /sessionStorage\.getItem\(`siragpt:lastEventId:\$\{data\.chatId\}`\)/,
      "a fresh generate must not resume the previous turn's cursor",
    )
    assert.match(apiSource, /if \(responseCursor\) \{\s*lastEventId = responseCursor;/)
    assert.match(apiSource, /flushTimer = setTimeout\(/, "short replies must paint without waiting for [DONE]")
    assert.match(
      generateSource,
      /createClientGoneWriter\(req, res, function \(\) \{ clientGone = true; \}\)/,
      "generate must only mark the client gone when the socket is really gone",
    )
  })

  it("emits [DONE] from generate finally when persist finished", () => {
    const idx = generateSource.indexOf("Safari/Cloudflare can drop the socket after persist")
    assert.ok(idx > 0, "generate finally must mention Safari persist-then-poll")
    const block = generateSource.slice(idx, idx + 700)
    assert.match(block, /data: \[DONE\]/)
    assert.match(block, /streamCompleted/)
    assert.match(block, /clientGone/)
    assert.match(generateSource, /typeof res\.flush === 'function'/)
  })
})
