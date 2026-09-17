import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const context = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)
const composer = fs.readFileSync(
  path.join(process.cwd(), "components", "chat-interface-enhanced.tsx"),
  "utf8",
)

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing marker ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, `missing marker ${endMarker}`)
  return source.slice(start, end)
}

describe("chat concurrency recovery source contract", () => {
  it("ignores a late selectChat response for focus while still updating its cache", () => {
    const selectChat = sliceBetween(context, "const selectChat = useCallback(", "  const clearCurrentChat")
    assert.match(selectChat, /latestSelectedChatIdRef\.current = chatId/)
    assert.match(
      selectChat,
      /setCurrentChat\(prev => \{[\s\S]{0,160}latestSelectedChatIdRef\.current !== chatId[\s\S]{0,80}return prev/,
    )
    assert.match(selectChat, /setChats\(\(prev\) => \{/)
    assert.match(
      selectChat,
      /if \(latestSelectedChatIdRef\.current === chatId\) \{[\s\S]{0,120}localStorage\.setItem\('currentChatId', chatId\)/,
    )
  })

  it("copies a failed stream partial into both visible state and cache before bg.fail", () => {
    const addMessage = sliceBetween(context, "const addMessage = useCallback(", "  const retryPendingMessage")
    const partialIndex = addMessage.indexOf("const failedPartial = bg.get(activeChat.id)?.partialContent")
    const currentIndex = addMessage.indexOf("setCurrentChat((prev)", partialIndex)
    const cacheIndex = addMessage.indexOf("setChats((prev)", partialIndex)
    const failIndex = addMessage.indexOf("bg.fail(activeChat.id", partialIndex)
    assert.ok(partialIndex >= 0 && currentIndex > partialIndex)
    assert.ok(cacheIndex > currentIndex && failIndex > cacheIndex)
    assert.match(addMessage.slice(partialIndex, failIndex), /hydrateTrailingAssistant/)
  })

  it("tags the optimistic USER and assistant placeholder with the same turn key", () => {
    const send = sliceBetween(composer, "// Optimistically add the user message", "    if (isNewChat)")
    assert.equal(send.match(/metadata: JSON\.stringify\(\{ idempotencyKey \}\)/g)?.length, 2)
  })

  it("persists and reuses stream ownership for reload followers and Stop", () => {
    const addMessage = sliceBetween(context, "const addMessage = useCallback(", "  const retryPendingMessage")
    const retry = sliceBetween(context, "const retryPendingMessage = useCallback", "  const retryPendingMessageRef")
    assert.match(addMessage, /savePending\([\s\S]*?String\(user\.id\),[\s\S]*?requestedStreamId/)
    assert.match(addMessage, /const streamId = pendingMessage\?\.streamId \|\| requestedStreamId/)
    assert.match(retry, /streamId: msg\.streamId/)
    assert.match(context, /stopAIStream\(streamIdToStop, targetChatId\)/)
  })

  it("owns Stop before slow regenerate deletes/edits and fences the generation start", () => {
    const regenerate = sliceBetween(context, "const regenerateMessageImpl", "  const regenerateMessageRef")
    const edit = sliceBetween(context, "const editAndRegenerate", "  const pollVideoStatus")

    assert.ok(regenerate.indexOf("markChatStreaming(currentChat.id, streamId, controller)")
      < regenerate.indexOf("apiClient.clearMessageById"))
    assert.match(regenerate, /awaitCancellableChatStep\([\s\S]*?clearMessageById/)
    assert.match(regenerate, /throwIfRegenerationCancelled\(\);[\s\S]{0,120}await apiClient\.generateAIStream/)

    assert.ok(edit.indexOf("markChatStreaming(currentChat.id, streamId, controller)")
      < edit.indexOf("apiClient.editUserMessage"))
    assert.match(edit, /awaitCancellableChatStep\([\s\S]*?editUserMessage/)
    assert.match(edit, /throwIfEditRegenerationCancelled\(\);[\s\S]{0,120}await apiClient\.generateAIStream/)
  })

  it("uses serialized recursive polling for both video and thesis", () => {
    const polling = sliceBetween(context, "const pollVideoStatus", "  const updateMessageInChat")
    assert.equal(polling.match(/startSerializedPreviewPoll<any/g)?.length, 2)
    assert.doesNotMatch(polling, /setInterval\(async/)
  })
})
