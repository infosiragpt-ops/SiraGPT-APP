import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isExplicitUserStop,
  pollPersistedAssistantTurn,
  shouldRecoverPersistedGenerate,
} from "../lib/recover-persisted-turn"

describe("recover persisted generate turn", () => {
  it("does not treat Safari AbortError as user Stop", () => {
    assert.equal(isExplicitUserStop(undefined, false), false)
    assert.equal(shouldRecoverPersistedGenerate({ name: "AbortError" }), true)
    const stopped = new AbortController()
    stopped.abort()
    assert.equal(isExplicitUserStop(stopped.signal, false), true)
    assert.equal(
      shouldRecoverPersistedGenerate({ name: "AbortError" }, { signal: stopped.signal }),
      false,
    )
  })

  it("recovers Cloudflare 520 and failed-to-fetch cuts", () => {
    assert.equal(shouldRecoverPersistedGenerate({ status: 520, message: "error code: 520" }), true)
    assert.equal(shouldRecoverPersistedGenerate({ name: "TypeError", message: "Failed to fetch" }), true)
    assert.equal(shouldRecoverPersistedGenerate({ status: 429, message: "quota" }), false)
  })

  it("polls getChat until the assistant row for this turn exists", async () => {
    const pending = { idempotencyKey: "turn-1", turnKey: "turn-1", streamId: "stream-1" }
    let calls = 0
    const recovered = await pollPersistedAssistantTurn({
      chatId: "chat-1",
      pending,
      attempts: 3,
      delayMs: 0,
      getChat: async () => {
        calls += 1
        if (calls < 2) {
          return {
            chat: {
              id: "chat-1",
              messages: [
                { role: "USER", content: "1+1", metadata: { idempotencyKey: "turn-1" } },
              ],
            },
          }
        }
        return {
          chat: {
            id: "chat-1",
            messages: [
              { role: "USER", content: "1+1", metadata: { idempotencyKey: "turn-1" } },
              { role: "ASSISTANT", content: "¡2!", metadata: { idempotencyKey: "turn-1" } },
            ],
          },
        }
      },
    })
    assert.equal(calls, 2)
    assert.equal(recovered?.chat.messages.at(-1).content, "¡2!")
  })

  it("stops polling when the user hits Stop", async () => {
    let calls = 0
    const recovered = await pollPersistedAssistantTurn({
      chatId: "chat-1",
      pending: { idempotencyKey: "turn-1", turnKey: "turn-1", streamId: "s" },
      attempts: 5,
      delayMs: 0,
      isCancelled: () => true,
      getChat: async () => {
        calls += 1
        return { chat: { messages: [] } }
      },
    })
    assert.equal(recovered, null)
    assert.equal(calls, 0)
  })
})
