import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  buildPendingGeneratePayload,
  clear,
  clearTurn,
  count,
  enableAutomaticRetry,
  findPendingTurnMatch,
  getAll,
  getForChat,
  retryAll,
  save,
} from "../lib/pending-messages"

/**
 * pending-messages persists outgoing chat sends to localStorage so the
 * UI can re-attempt them when the network comes back. Tested here:
 *
 *   1. save / clear / getAll round-trip
 *   2. One-per-turn invariant — sibling tab keys coexist safely
 *   3. retryAll: success removes, failure increments attempts, cap stops
 *   4. SSR-safety: APIs are no-op when window is undefined
 *
 * The module reads `localStorage` directly, so we install a minimal
 * in-memory shim on globalThis.window before each suite.
 */

const STORAGE_KEY = "sira_pending_messages"

let store: Record<string, string> = {}

function installFakeLocalStorage() {
  store = {}
  const fakeLocalStorage = {
    getItem(key: string) {
      return key in store ? store[key] : null
    },
    setItem(key: string, value: string) {
      store[key] = value
    },
    removeItem(key: string) {
      delete store[key]
    },
    clear() {
      store = {}
    },
  }
  ;(globalThis as any).window = { localStorage: fakeLocalStorage, navigator: { onLine: true } }
  ;(globalThis as any).localStorage = fakeLocalStorage
}

function uninstallFakeLocalStorage() {
  delete (globalThis as any).window
  delete (globalThis as any).localStorage
  store = {}
}

describe("pending-messages · save / clear / get round-trip", () => {
  beforeEach(installFakeLocalStorage)
  afterEach(uninstallFakeLocalStorage)

  it("save returns a PendingMessage with the right shape and persists it", () => {
    const msg = save("hola", "chat-1")
    assert.equal(msg.content, "hola")
    assert.equal(msg.chatId, "chat-1")
    assert.equal(msg.idempotencyKey, msg.id)
    assert.equal(msg.attempts, 0)
    assert.equal(msg.maxAttempts, 5)
    assert.match(msg.id, /^chat-1-\d+-/)

    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1")?.content, "hola")
  })

  it("saving twice for the same chat REPLACES the previous draft", () => {
    save("first attempt", "chat-1", undefined, undefined, "same-turn")
    save("second attempt", "chat-1", undefined, undefined, "same-turn")
    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1")?.content, "second attempt")
  })

  it("keeps different tab turns in one chat and clears only the terminal key", () => {
    save("tab one", "chat-1", undefined, undefined, "turn-k1", undefined, "user-1")
    save("tab two", "chat-1", undefined, undefined, "turn-k2", undefined, "user-1")
    assert.equal(count(), 2)

    clearTurn("chat-1", "turn-k1", "user-1")
    assert.deepEqual(getAll().map((message) => message.idempotencyKey), ["turn-k2"])
  })

  it("persists an explicit turn key and migrates legacy drafts to their immutable id", () => {
    const keyed = save("stable", "chat-1", undefined, undefined, "turn-stable-1")
    assert.equal(keyed.idempotencyKey, "turn-stable-1")
    assert.equal(getForChat("chat-1")?.idempotencyKey, "turn-stable-1")

    const legacy = { ...keyed }
    delete (legacy as Partial<typeof legacy>).idempotencyKey
    store[STORAGE_KEY] = JSON.stringify([legacy])
    assert.equal(getForChat("chat-1")?.idempotencyKey, keyed.id)
  })

  it("replays the original model envelope after reload even when defaults changed", () => {
    const originalEnvelope = {
      provider: "OpenAI",
      model: "model-a",
      reasoningEffort: "high",
      disableAgentic: true,
    }
    const pending = save(
      "stable model turn",
      "chat-1",
      ["file-1"],
      undefined,
      "turn-model-a",
      originalEnvelope,
    )
    const automatic = enableAutomaticRetry(
      pending.chatId,
      pending.idempotencyKey,
      "text",
      originalEnvelope,
    )
    assert.equal(automatic?.retryPolicy, "automatic")

    // Simulate a reload where the composer now defaults to provider/model B.
    const payload = buildPendingGeneratePayload({
      pending: getForChat("chat-1"),
      fallbackEnvelope: {
        provider: "Anthropic",
        model: "model-b",
        reasoningEffort: "low",
      },
      prompt: pending.content,
      chatId: pending.chatId,
      files: pending.fileIds,
      streamId: "fresh-transport-id",
      idempotencyKey: pending.idempotencyKey,
    })

    assert.equal(payload.idempotencyKey, "turn-model-a")
    assert.equal(payload.provider, "OpenAI")
    assert.equal(payload.model, "model-a")
    assert.equal(payload.reasoningEffort, "high")
    assert.equal(payload.disableAgentic, true)
    assert.deepEqual(payload.files, ["file-1"])
  })

  it("reuses the original owner stream id after reload so Stop targets the real stream", () => {
    const original = save(
      "durable stop",
      "chat-1",
      undefined,
      undefined,
      "turn-stop-1",
      { provider: "OpenAI", model: "model-a" },
      "user-1",
      "owner-stream-1",
    )
    enableAutomaticRetry(
      original.chatId,
      original.idempotencyKey,
      "text",
      original.requestEnvelope!,
      "user-1",
    )

    // getForChat is the reload boundary: only durable storage survives.
    const reloaded = getForChat("chat-1")!
    const followerPayload = buildPendingGeneratePayload({
      pending: reloaded,
      fallbackEnvelope: { provider: "Anthropic", model: "model-b" },
      prompt: reloaded.content,
      chatId: reloaded.chatId,
      streamId: reloaded.streamId || "incorrect-new-stream",
      idempotencyKey: reloaded.idempotencyKey,
    })

    assert.equal(reloaded.streamId, "owner-stream-1")
    assert.equal(followerPayload.streamId, "owner-stream-1")
    assert.equal(followerPayload.idempotencyKey, "turn-stop-1")
  })

  it("does not confuse two equal prompts with different turn keys", () => {
    const pending = save("sí", "chat-1", undefined, undefined, "turn-second", {
      provider: "OpenAI",
      model: "model-a",
    })
    const messages = [
      { role: "USER", content: "sí", metadata: JSON.stringify({ idempotencyKey: "turn-first" }) },
      { role: "ASSISTANT", content: "Primera respuesta", metadata: { idempotencyKey: "turn-first" } },
      { role: "USER", content: "sí", metadata: { idempotencyKey: "turn-second" } },
    ]

    assert.deepEqual(findPendingTurnMatch(messages, pending), {
      userIndex: 2,
      assistantIndex: -1,
      hasAssistantReply: false,
    })

    messages.push({
      role: "ASSISTANT",
      content: "Segunda respuesta",
      metadata: JSON.stringify({ idempotencyKey: "turn-second" }),
    })
    assert.deepEqual(findPendingTurnMatch(messages, pending), {
      userIndex: 2,
      assistantIndex: 3,
      hasAssistantReply: true,
    })
  })

  it("saving for a different chat appends without affecting the first", () => {
    save("a", "chat-1")
    save("b", "chat-2")
    assert.equal(count(), 2)
    assert.equal(getForChat("chat-1")?.content, "a")
    assert.equal(getForChat("chat-2")?.content, "b")
  })

  it("clear removes the draft for one chat and leaves others intact", () => {
    save("a", "chat-1")
    save("b", "chat-2")
    clear("chat-1")
    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1"), undefined)
    assert.equal(getForChat("chat-2")?.content, "b")
  })

  it("clear of a non-existent chat is a no-op", () => {
    save("a", "chat-1")
    clear("chat-2")
    assert.equal(count(), 1)
  })

  it("getAll returns every persisted message", () => {
    save("a", "chat-1")
    save("b", "chat-2")
    save("c", "chat-3")
    const all = getAll()
    assert.equal(all.length, 3)
  })

  it("removes the storage key entirely when the last draft is cleared", () => {
    save("a", "chat-1")
    clear("chat-1")
    assert.equal(store[STORAGE_KEY], undefined)
  })

  it("recovers gracefully from a corrupted localStorage payload", () => {
    store[STORAGE_KEY] = "{not valid json"
    assert.deepEqual(getAll(), [])
    assert.equal(count(), 0)
  })
})

describe("pending-messages · retryAll", () => {
  beforeEach(installFakeLocalStorage)
  afterEach(uninstallFakeLocalStorage)

  it("returns 0/0 when there's nothing to retry", async () => {
    const result = await retryAll(async () => true)
    assert.deepEqual(result, { retried: 0, stillPending: 0 })
  })

  it("removes a message from storage when sendFn resolves true", async () => {
    save("send me", "chat-1")
    const result = await retryAll(async () => true)
    assert.equal(result.retried, 1)
    assert.equal(result.stillPending, 0)
    assert.equal(count(), 0)
  })

  it("keeps a message in storage when sendFn resolves false", async () => {
    save("retry me", "chat-1")
    const result = await retryAll(async () => false)
    assert.equal(result.retried, 0)
    assert.equal(result.stillPending, 1)
    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1")?.attempts, 1)
  })

  it("skips messages that have hit the attempt cap", async () => {
    const msg = save("done", "chat-1")
    // Manually bump attempts to maxAttempts via localStorage.
    store[STORAGE_KEY] = JSON.stringify([{ ...msg, attempts: msg.maxAttempts }])
    let sent = 0
    const result = await retryAll(async () => {
      sent++
      return true
    })
    assert.equal(sent, 0, "send fn must not be called once cap is reached")
    assert.equal(result.stillPending, 1)
  })

  it("counts thrown sendFn exceptions as stillPending and keeps the message", async () => {
    save("crashy", "chat-1")
    const result = await retryAll(async () => {
      throw new Error("network down")
    })
    assert.equal(result.retried, 0)
    assert.equal(result.stillPending, 1)
    assert.equal(count(), 1)
    assert.match(getForChat("chat-1")?.lastError || "", /network down/)
    assert.ok(getForChat("chat-1")?.nextRetryAt)
  })

  it("does not retry before nextRetryAt", async () => {
    const msg = save("later", "chat-1")
    store[STORAGE_KEY] = JSON.stringify([
      { ...msg, nextRetryAt: new Date(Date.now() + 60_000).toISOString() },
    ])
    let sent = 0
    const result = await retryAll(async () => {
      sent++
      return true
    })
    assert.equal(sent, 0)
    assert.deepEqual(result, { retried: 0, stillPending: 1 })
  })

  it("never replays or charges attempts for another signed-in owner", async () => {
    save(
      "private draft",
      "chat-1",
      undefined,
      undefined,
      "turn-owner-a",
      { provider: "OpenAI", model: "model-a" },
      "user-a",
    )
    let sent = 0
    const result = await retryAll(async () => {
      sent++
      return "success"
    }, { ownerId: "user-b" })

    assert.equal(sent, 0)
    assert.deepEqual(result, { retried: 0, stillPending: 1 })
    assert.equal(getForChat("chat-1")?.attempts, 0)
    assert.equal(getForChat("chat-1")?.ownerId, "user-a")
  })

  it("does not consume attempts across five deferrals, then clears on terminal replay", async () => {
    const pending = save("owner still running", "chat-1", undefined, undefined, "turn-owner-1")
    const observedKeys: string[] = []

    for (let index = 0; index < 5; index++) {
      const deferred = await retryAll(async (msg) => {
        observedKeys.push(msg.idempotencyKey || msg.id)
        return "defer"
      })
      assert.deepEqual(deferred, { retried: 0, stillPending: 1 })
      assert.equal(getForChat("chat-1")?.attempts, 0)
      assert.equal(getForChat("chat-1")?.nextRetryAt, undefined)
    }
    assert.equal(count(), 1, "an active owner must stay pending without using retry budget")

    const replay = await retryAll(async (msg) => {
      observedKeys.push(msg.idempotencyKey || msg.id)
      return "success"
    })
    assert.deepEqual(replay, { retried: 1, stillPending: 0 })
    assert.deepEqual(observedKeys, Array(6).fill(pending.idempotencyKey))
    assert.equal(count(), 0, "terminal replay removes the durable pending turn")
  })
})

describe("pending-messages · SSR safety", () => {
  beforeEach(uninstallFakeLocalStorage)
  afterEach(uninstallFakeLocalStorage)

  it("getAll returns [] when window is undefined", () => {
    assert.deepEqual(getAll(), [])
    assert.equal(count(), 0)
  })

  it("clear is a silent no-op when window is undefined", () => {
    assert.doesNotThrow(() => clear("chat-1"))
  })
})
