import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const componentPath = path.join(process.cwd(), "lib", "chat-context-integrated.tsx")
const source = fs.readFileSync(componentPath, "utf8")

function sliceBetween(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`)
  return source.slice(start, end)
}

describe("pending message retry active stream contract", () => {
  it("does not re-send a pending message while that chat already has an active stream", () => {
    const retryPendingMessage = sliceBetween(
      "const retryPendingMessage = useCallback(async (msg: PendingMessage) => {",
      "  useEffect(() => {"
    )

    assert.match(
      retryPendingMessage,
      /activeStreamingChatIdsRef\.current\.has\(msg\.chatId\)[\s\S]{0,160}return false/,
      "online/init pending-message retry must skip active streaming chats instead of calling addMessage a second time"
    )

    const guardIndex = retryPendingMessage.indexOf("activeStreamingChatIdsRef.current.has(msg.chatId)")
    const addMessageIndex = retryPendingMessage.indexOf("await addMessage(")
    assert.ok(guardIndex >= 0 && addMessageIndex >= 0 && guardIndex < addMessageIndex,
      "active-stream guard must run before retryPendingMessage can call addMessage")
  })
})
