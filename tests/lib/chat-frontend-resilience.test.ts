import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const chatSource = readFileSync(
  resolve(process.cwd(), "components/chat-interface-enhanced.tsx"),
  "utf8",
)
const authSource = readFileSync(
  resolve(process.cwd(), "lib/auth-context-integrated.tsx"),
  "utf8",
)

describe("chat frontend resilience contracts", () => {
  it.each([
    "text-to-speech-component",
    "MusicGenerationComponent",
    "VideoGenerationComponent",
  ])("loads the optional %s studio on demand", (moduleName) => {
    expect(chatSource).toContain(`() => import(\"./${moduleName}\")`)
    const escapedModuleName = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(chatSource).not.toMatch(
      new RegExp(`import\\s+\\w+\\s+from\\s+[\"']\\./${escapedModuleName}[\"']`),
    )
  })

  it("makes durable queue hydration observable by the drain effect", () => {
    expect(chatSource).toContain("setQueueHydrationVersion((version) => version + 1)")
    const drain = chatSource.slice(
      chatSource.indexOf("  // Drain queued messages when a chat's pipeline goes idle."),
      chatSource.indexOf("  // Prevent Enter key from adding new line"),
    )
    const dependencies = drain.match(/\}, \[([\s\S]*?)\]\);/)?.[1]
      ?.split(",").map(value => value.trim()) || []
    expect(dependencies).toEqual(expect.arrayContaining([
      "syncQueuedCount", "queueHydrationVersion", "isSending", "sendingChatId",
    ]))
  })

  it("keeps queued work durable until its send succeeds", () => {
    expect(chatSource).toContain("queueDrainClaims.add(next.id)")
    expect(chatSource).toMatch(
      /await handleSendRef\.current\(\);[\s\S]*?queuedSendSucceededRef\.current\.get\(claimed\.id\) === true[\s\S]*?pendingMsgQueueRef\.current\.splice\(completedIndex, 1\)/,
    )
    expect(chatSource).toMatch(
      /await addMessage\([\s\S]*?pendingMsgQueueRef\.current\.splice\(completedIndex, 1\)/,
    )
    expect(chatSource).toContain("if (!started) queueDrainClaims.delete")
  })

  it("clears durable drafts and queued tasks during logout", () => {
    expect(authSource).toContain("clearAllChatDrafts()")
    expect(authSource).toContain("clearPersistedComposerQueues()")
  })
})
