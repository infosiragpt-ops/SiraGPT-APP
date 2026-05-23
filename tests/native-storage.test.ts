import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import * as storage from "../lib/native/storage"

type LocalStorageShim = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  key(i: number): string | null
  clear(): void
  length: number
}

function makeLocalStorageShim(): LocalStorageShim {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, String(v))
    },
    removeItem: (k) => {
      map.delete(k)
    },
    key: (i) => Array.from(map.keys())[i] ?? null,
    clear: () => {
      map.clear()
    },
    get length() {
      return map.size
    },
  }
}

describe("lib/native/storage", () => {
  beforeEach(() => {
    storage._resetBackendForTests()
    const g = globalThis as unknown as Record<string, unknown>
    g.window = { localStorage: makeLocalStorageShim() }
    // ensure no Capacitor flag leaks in
    delete g.Capacitor
  })

  afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>
    delete g.window
    storage._resetBackendForTests()
  })

  it("set/get round-trips a string", async () => {
    await storage.setItem("a", "1")
    assert.equal(await storage.getItem("a"), "1")
  })

  it("returns null for missing keys", async () => {
    assert.equal(await storage.getItem("missing"), null)
  })

  it("remove deletes a key", async () => {
    await storage.setItem("k", "v")
    await storage.removeItem("k")
    assert.equal(await storage.getItem("k"), null)
  })

  it("setJSON/getJSON round-trips an object", async () => {
    await storage.setJSON("obj", { hello: "world", n: 42 })
    const got = await storage.getJSON<{ hello: string; n: number }>("obj")
    assert.deepEqual(got, { hello: "world", n: 42 })
  })

  it("getJSON returns null on parse error", async () => {
    await storage.setItem("bad", "{not json")
    assert.equal(await storage.getJSON("bad"), null)
  })

  it("falls back to in-memory when no window is present", async () => {
    const g = globalThis as unknown as Record<string, unknown>
    delete g.window
    storage._resetBackendForTests()
    await storage.setItem("mem", "ok")
    assert.equal(await storage.getItem("mem"), "ok")
  })

  it("clear empties all keys", async () => {
    await storage.setItem("a", "1")
    await storage.setItem("b", "2")
    await storage.clear()
    assert.deepEqual(await storage.keys(), [])
  })
})
