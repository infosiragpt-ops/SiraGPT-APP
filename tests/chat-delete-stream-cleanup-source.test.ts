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

describe("chat deletion streaming cleanup source contract", () => {
  it("has a chat-scoped stream discard helper that aborts local/backend generation and clears placeholders", () => {
    assert.match(
      source,
      /const currentStreamIdRef = useRef<string \| null>\(null\)/,
      "delete needs a ref for the latest stream id; callback closures can be stale while a stream is active",
    )

    const cleanup = sliceBetween(
      "const discardActiveStreamForChat = useCallback(",
      "// Stable, identity-preserving snapshot getter",
    )

    assert.match(cleanup, /streamControllersRef\.current\.get\(chatId\)/, "cleanup must find chat-scoped controllers")
    assert.match(cleanup, /tracked\?\.controller\.abort\(\)/, "cleanup must abort foreground/background fetches")
    assert.match(cleanup, /abortControllerRef\.current\?\.abort\(\)/, "cleanup must abort non-default generator controllers for the current chat")
    assert.match(cleanup, /activeStreamingChatIdsRef\.current\.delete\(chatId\)/, "cleanup must remove the deleted chat from active streaming ids")
    assert.match(cleanup, /streamBufferRef\.current\?\.dispose\(\)/, "cleanup must dispose queued rAF token flushes so no empty assistant placeholder leaks")
    assert.match(cleanup, /clearPending\(chatId\)/, "cleanup must prevent pending-message retry from resurrecting the deleted chat")
    assert.match(cleanup, /bg\.cancel\(chatId\)/, "cleanup must remove the deleted chat from background stream UI")
    assert.match(cleanup, /apiClient\.stopAIStream\(streamIdToStop\)/, "cleanup must notify the backend stream controller when a stream id is known")
  })

  it("deleteChat invokes cleanup before deletion and clears stale current-chat selection", () => {
    const deleteBlock = sliceBetween(
      "const deleteChat = useCallback(",
      "\n\n  const regenerateMessage",
    )

    assert.match(
      deleteBlock,
      /discardActiveStreamForChat\(chatId,\s*\{\s*notifyBackend:\s*true\s*\}\)/,
      "deleteChat must cancel an in-flight generation for the chat being deleted before awaiting the DELETE request",
    )
    assert.match(
      deleteBlock,
      /setCurrentChat\(prev => \(prev\?\.id === chatId \? null : prev\)\)/,
      "deleteChat must clear the current chat with a functional update so stale closures cannot leave the deleted chat selected",
    )
    assert.match(
      deleteBlock,
      /localStorage\.removeItem\('currentChatId'\)/,
      "deleteChat must remove the persisted currentChatId when the selected chat is deleted",
    )
  })
})
