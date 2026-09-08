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
      "const retryPendingMessage = useCallback(async (msg: PendingMessage): Promise<PendingRetryResult> => {",
      "  useEffect(() => {"
    )

    assert.match(
      retryPendingMessage,
      /activeStreamingChatIdsRef\.current\.has\(msg\.chatId\)[\s\S]{0,160}return 'defer'/,
      "online/init pending-message retry must skip active streaming chats instead of calling addMessage a second time"
    )

    const guardIndex = retryPendingMessage.indexOf("activeStreamingChatIdsRef.current.has(msg.chatId)")
    const addMessageIndex = retryPendingMessage.indexOf("await addMessage(")
    assert.ok(guardIndex >= 0 && addMessageIndex >= 0 && guardIndex < addMessageIndex,
      "active-stream guard must run before retryPendingMessage can call addMessage")
  })

  it("reuses the persisted turn key and clears only after terminal success", () => {
    const addMessage = sliceBetween(
      "const addMessage = useCallback(",
      "  const retryPendingMessage = useCallback"
    )
    const retryPendingMessage = sliceBetween(
      "const retryPendingMessage = useCallback(async (msg: PendingMessage): Promise<PendingRetryResult> => {",
      "  useEffect(() => {"
    )

    assert.match(addMessage, /savePending\([\s\S]*?requestedIdempotencyKey \|\| undefined/)
    assert.match(addMessage, /enableAutomaticRetry\([\s\S]*?turnIdempotencyKey[\s\S]*?requestEnvelope/)
    assert.match(addMessage, /buildPendingGeneratePayload\(\{[\s\S]*?idempotencyKey: turnIdempotencyKey/)
    assert.match(addMessage, /metadata: turnMetadata/)
    assert.match(addMessage, /findPendingTurnMatch\(activeChat\.messages \|\| \[\]/)
    assert.match(addMessage, /reuseAssistantPlaceholder[\s\S]*?messages\.map/)
    assert.match(addMessage, /if \(terminalSucceeded\) \{[\s\S]{0,100}clearThisPendingTurn\(\)/)
    assert.match(addMessage, /return terminalSucceeded/)
    assert.match(retryPendingMessage, /msg\.retryPolicy !== 'automatic' \|\| !msg\.requestEnvelope[\s\S]{0,60}return 'defer'/)
    assert.match(retryPendingMessage, /msg\.ownerId !== currentUserIdRef\.current[\s\S]{0,60}return 'defer'/)
    assert.match(
      retryPendingMessage,
      /idempotencyKey: msg\.idempotencyKey \|\| msg\.turnKey \|\| msg\.id/,
    )
    assert.match(retryPendingMessage, /reusePending: true/)
    assert.match(retryPendingMessage, /requestEnvelope: msg\.requestEnvelope/)
    assert.match(retryPendingMessage, /streamId: msg\.streamId/)
    assert.match(retryPendingMessage, /const terminal = await addMessage\([\s\S]*?return terminal === true \? 'success' : 'failure'/)
    assert.doesNotMatch(retryPendingMessage, /message\?\.content !== msg\.content/)
    assert.match(retryPendingMessage, /findPendingTurnMatch\(messages, msg\)/)
  })

  it("keeps the online subscription stable while reading the latest retry callback", () => {
    const retrySection = sliceBetween(
      "const retryPendingMessageRef = useRef(retryPendingMessage)",
      "  const handleNewChatWithPlaceholder"
    )

    assert.match(retrySection, /retryPendingMessageRef\.current = retryPendingMessage/)
    assert.match(retrySection, /retryWithLatestContext/)
    assert.match(retrySection, /\[retryOwnerId, isAuthenticated\]/)
    assert.doesNotMatch(retrySection, /\[user, isAuthenticated, retryPendingMessage\]/)
  })
})
