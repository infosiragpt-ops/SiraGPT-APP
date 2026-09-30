import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const context = fs.readFileSync(
  path.join(process.cwd(), "lib", "chat-context-integrated.tsx"),
  "utf8",
)

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing marker ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, `missing marker ${endMarker}`)
  return source.slice(start, end)
}

describe("chat context resilience source contract", () => {
  it("loads the chat list in parallel with models and initializes even if models fail", () => {
    const init = sliceBetween(context, "const initializeChat = async () => {", "const loadModelsForType")
    const chatsIndex = init.indexOf("const chatsPromise = loadUserChats()")
    const modelsIndex = init.indexOf("apiClient.getAIModels(")
    assert.ok(chatsIndex >= 0 && modelsIndex > chatsIndex, "chats must start before the models request")
    const catchIndex = init.indexOf("} catch (error) {")
    const awaitIndex = init.indexOf("await chatsPromise")
    const initializedIndex = init.indexOf("setHasInitialized(true)")
    assert.ok(catchIndex > modelsIndex && awaitIndex > catchIndex && initializedIndex > awaitIndex,
      "hasInitialized must be set outside the models try/catch")
  })

  it("retries the model catalog when the browser comes back online", () => {
    assert.match(context, /window\.addEventListener\('online', onOnline\)/)
    assert.match(context, /window\.removeEventListener\('online', onOnline\)/)
  })

  it("drives the sidebar skeleton from the chat-list fetch, not from message streaming", () => {
    assert.match(context, /isLoadingChats: isLoadingChatList,/)
    assert.doesNotMatch(context, /isLoadingChats: isLoading,/)
    const loadChats = sliceBetween(context, "const loadUserChats = async (", "// Load more chats for infinite scroll")
    assert.match(loadChats, /setIsLoadingChatList\(true\)/)
    assert.match(loadChats, /finally \{[\s\S]*setIsLoadingChatList\(false\)/)
  })

  it("de-duplicates appended chat pages by id", () => {
    const loadChats = sliceBetween(context, "const loadUserChats = async (", "// Load more chats for infinite scroll")
    assert.doesNotMatch(loadChats, /setChats\(prev => \[\.\.\.prev, \.\.\.response\.chats\]\)/)
    assert.match(loadChats, /!seen\.has\(c\.id\)/)
  })

  it("marks a stopped reply in Spanish and settles its placeholder", () => {
    const stop = sliceBetween(context, "const stopStreaming = useCallback(", "const addMessage = useCallback(")
    assert.doesNotMatch(stop, /"\(Generation stopped by user\)"/)
    assert.match(stop, /Generación detenida/)
    assert.match(stop, /finalizeAssistantPlaceholder\(lastMessage\)/)
  })

  it("clears the background entry on user Stop instead of marking it failed", () => {
    const addMessage = sliceBetween(context, "const addMessage = useCallback(", "  const retryPendingMessage")
    assert.match(
      addMessage,
      /if \(isUserStopped\(\)\) \{\s*bg\.cancel\(activeChat\.id\);\s*\} else \{\s*bg\.fail\(activeChat\.id/,
    )
  })

  it("tells the user when a chat cannot be opened, with a retry for transient errors", () => {
    const selectChat = sliceBetween(context, "const selectChat = useCallback(", "  const clearCurrentChat")
    assert.match(selectChat, /No se pudo cargar la conversación completa\./)
    assert.match(selectChat, /label: "Reintentar"/)
    assert.match(selectChat, /Esta conversación ya no existe o no tienes acceso\./)
    assert.match(selectChat, /stillSelected && !restoredFromStorage/)
  })

  it("never lets a blocked/full localStorage abort chat creation or selection", () => {
    const unguarded = context
      .split("\n")
      .filter((line) => line.includes("localStorage.setItem('currentChatId'"))
      .filter((line) => !line.includes("try {"))
    assert.deepEqual(unguarded, [])
  })
})
