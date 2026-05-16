import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  clear,
  count,
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
 *   2. One-per-chat invariant — saving twice replaces, not appends
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
    assert.equal(msg.attempts, 0)
    assert.equal(msg.maxAttempts, 3)
    assert.match(msg.id, /^chat-1-\d+-/)

    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1")?.content, "hola")
  })

  it("saving twice for the same chat REPLACES the previous draft", () => {
    save("first attempt", "chat-1")
    save("second attempt", "chat-1")
    assert.equal(count(), 1)
    assert.equal(getForChat("chat-1")?.content, "second attempt")
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
