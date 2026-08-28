import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"

import {
  LAST_MODEL_STORAGE_KEY,
  PINNED_MODEL_STORAGE_KEY,
  clearPinnedModel,
  getLastModel,
  getPinnedModel,
  isPinnedModel,
  setLastModel,
  setPinnedModel,
} from "../lib/chat/model-preference"

const store = new Map<string, string>()

function installMemoryStorage() {
  const memory = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
    removeItem(key: string) {
      store.delete(key)
    },
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: memory },
  })
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memory,
  })
}

describe("chat model preference", () => {
  beforeEach(() => {
    store.clear()
    installMemoryStorage()
  })

  it("pins and unpins a default without touching the last pick", () => {
    setLastModel("deepseek-v4-flash")
    setPinnedModel("sira-gpt-mini")
    assert.equal(getPinnedModel(), "sira-gpt-mini")
    assert.equal(isPinnedModel("sira-gpt-mini"), true)
    assert.equal(isPinnedModel("deepseek-v4-flash"), false)
    assert.equal(getLastModel(), "deepseek-v4-flash")
    clearPinnedModel()
    assert.equal(getPinnedModel(), "")
    assert.equal(store.has(PINNED_MODEL_STORAGE_KEY), false)
    assert.equal(store.get(LAST_MODEL_STORAGE_KEY), "deepseek-v4-flash")
  })

  it("remembers the last pick for new chats", () => {
    setLastModel("SiraGPT Mini")
    assert.equal(getLastModel(), "SiraGPT Mini")
  })

  it("does not persist leftover Seedance / video ids as the TEXT default", () => {
    setLastModel("bytedance/seedance-2.0/text-to-video")
    setPinnedModel("bytedance/seedance-2.0/text-to-video")
    assert.equal(getLastModel(), "")
    assert.equal(getPinnedModel(), "")
    store.set(LAST_MODEL_STORAGE_KEY, "bytedance/seedance-2.0/text-to-video")
    store.set(PINNED_MODEL_STORAGE_KEY, "bytedance/seedance-2.0/text-to-video")
    assert.equal(getLastModel(), "")
    assert.equal(getPinnedModel(), "")
  })
})
