import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * «Crea un word con esta información…» vanished from the chat while the
 * document agent worked: handleAgentTask only inserted the user bubble when
 * the chat had NO user message at all, so any chat with history hid the new
 * request until the server persisted it. The check is now per goal.
 */
describe("agent-task turn keeps the user's request visible", () => {
  const chatInterface = source("components/chat-interface-enhanced.tsx")
  const handler = chatInterface.slice(chatInterface.indexOf("const handleAgentTask = async ("))
  assert.ok(handler.length > 1000, "handleAgentTask is defined")

  it("decides «already added» by the goal text, never by «any user message»", () => {
    assert.match(chatInterface, /import \{ hasUserTurnForGoal \} from "@\/lib\/chat\/agent-task-turn"/)
    assert.match(handler, /const liveHasUserTurn = hasUserTurnForGoal\(currentChatRef\.current\?\.messages, displayGoal\);/)
    assert.match(handler, /if \(hasUserTurnForGoal\(baseMessages, displayGoal\)\) return nextChat;/)
    assert.match(handler, /const withUser = hasUserTurnForGoal\(seeded, displayGoal\)/)
    assert.doesNotMatch(handler, /baseMessages\.some\(isUserRole\)\) return nextChat/)
    assert.doesNotMatch(handler, /seeded\.some\(isUserRole\)/)
    assert.doesNotMatch(handler, /\.some\(isUserRole\)/)
  })

  it("the deterministic agentic path still relies on handleAgentTask to add the bubble", () => {
    assert.match(chatInterface, /await handleAgentTask\(msg, filesToSend, \{ userMessageAlreadyAdded: false \}\);/)
  })
})
