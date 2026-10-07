import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  isRecoverableClientBundleError,
  reloadOnceForStaleBundle,
  staleReloadKey,
  STALE_RELOAD_COOLDOWN_MS,
  STALE_RELOAD_KEY_PREFIX,
} from "../lib/client-bundle-recovery"

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

const chunkError = () => Object.assign(new Error("Loading chunk 8731 failed."), { name: "ChunkLoadError" })

/**
 * «No se pudo cargar el admin» after a publish: the tab kept the previous
 * bundle and the /admin boundary only offered «Reintentar», which re-renders
 * the same stale chunks. The shared helper reloads once, per build + error,
 * with a cooldown so a broken build never loops.
 */
describe("stale-bundle recovery helper", () => {
  it("recognises the errors a previous deployment leaves behind", () => {
    assert.equal(isRecoverableClientBundleError(chunkError()), true)
    assert.equal(isRecoverableClientBundleError(new Error("Loading CSS chunk 12 failed")), true)
    assert.equal(isRecoverableClientBundleError(new Error("Failed to find Server Action \"abc\"")), true)
    assert.equal(isRecoverableClientBundleError(new Error("Failed to fetch dynamically imported module: /_next/x.js")), true)
    assert.equal(isRecoverableClientBundleError(Object.assign(new ReferenceError("AdminPanel is not defined"), { name: "ReferenceError" })), true)
    assert.equal(isRecoverableClientBundleError(new Error("Loading chunk app/admin/page failed")), true)
    assert.equal(isRecoverableClientBundleError(new TypeError("Cannot read properties of undefined")), false)
    assert.equal(isRecoverableClientBundleError(new Error("Request failed with status 500")), false)
    assert.equal(isRecoverableClientBundleError(null), false)
  })

  it("keys the guard by build and error signature", () => {
    const key = staleReloadKey(chunkError(), "build-42")
    assert.equal(key, `${STALE_RELOAD_KEY_PREFIX}:build-42:ChunkLoadError:Loading_chunk_8731_failed.`)
    assert.notEqual(staleReloadKey(chunkError(), "build-43"), key)
  })

  it("reloads once, then refuses inside the cooldown and reloads again after it", () => {
    const storage = memoryStorage()
    let reloads = 0
    let now = 1_000_000
    const opts = { storage, reload: () => { reloads += 1 }, buildId: "b1", now: () => now }
    assert.equal(reloadOnceForStaleBundle(chunkError(), opts), true)
    assert.equal(reloads, 1)
    assert.equal(reloadOnceForStaleBundle(chunkError(), opts), false, "same tab, same build, same error: no loop")
    assert.equal(reloads, 1)
    now += STALE_RELOAD_COOLDOWN_MS + 1
    assert.equal(reloadOnceForStaleBundle(chunkError(), opts), true, "a later deployment gets a fresh chance")
    assert.equal(reloads, 2)
  })

  it("never reloads for ordinary render errors and survives unavailable storage", () => {
    let reloads = 0
    const storage = memoryStorage()
    assert.equal(reloadOnceForStaleBundle(new TypeError("boom"), { storage, reload: () => { reloads += 1 }, buildId: "b1" }), false)
    const broken = { getItem: () => { throw new Error("private mode") }, setItem: () => { throw new Error("private mode") } }
    assert.equal(reloadOnceForStaleBundle(chunkError(), { storage: broken, reload: () => { reloads += 1 }, buildId: "b1" }), false)
    assert.equal(reloads, 0)
  })
})
