import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  AUTH_SESSION_STORAGE_KEY,
  AUTH_TOKEN_STORAGE_KEY,
  clearAuthSession,
  createAuthSessionRecord,
  fingerprintAuthToken,
  readAuthToken,
  writeAuthToken,
  type AuthStorage,
} from "../../lib/auth/session-storage"

class MemoryAuthStorage implements AuthStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe("auth session storage", () => {
  it("stores token metadata without duplicating the raw token", () => {
    const storage = new MemoryAuthStorage()

    writeAuthToken("secret-token", {
      source: "credentials",
      now: 1000,
      expiresInMs: 5000,
      storage,
    })

    const rawSession = storage.getItem(AUTH_SESSION_STORAGE_KEY)
    assert.equal(storage.getItem(AUTH_TOKEN_STORAGE_KEY), "secret-token")
    assert.equal(rawSession?.includes("secret-token"), false)

    const stored = readAuthToken({ now: 3000, storage })
    assert.equal(stored.token, "secret-token")
    assert.equal(stored.expired, false)
    assert.equal(stored.session?.source, "credentials")
    assert.equal(stored.session?.issuedAt, 1000)
    assert.equal(stored.session?.expiresAt, 6000)
  })

  it("clears expired token and metadata together", () => {
    const storage = new MemoryAuthStorage()

    writeAuthToken("demo-token", {
      source: "local-demo",
      now: 1000,
      expiresAt: 1500,
      storage,
    })

    const stored = readAuthToken({ now: 1500, storage })
    assert.equal(stored.token, null)
    assert.equal(stored.session, null)
    assert.equal(stored.expired, true)
    assert.equal(storage.getItem(AUTH_TOKEN_STORAGE_KEY), null)
    assert.equal(storage.getItem(AUTH_SESSION_STORAGE_KEY), null)
  })

  it("removes mismatched metadata but preserves the token for compatibility", () => {
    const storage = new MemoryAuthStorage()
    storage.setItem(AUTH_TOKEN_STORAGE_KEY, "live-token")
    storage.setItem(
      AUTH_SESSION_STORAGE_KEY,
      JSON.stringify(createAuthSessionRecord("other-token", { source: "credentials", now: 1000 })),
    )

    const stored = readAuthToken({ now: 1001, storage })
    assert.equal(stored.token, "live-token")
    assert.equal(stored.session, null)
    assert.equal(stored.expired, false)
    assert.equal(storage.getItem(AUTH_SESSION_STORAGE_KEY), null)
  })

  it("clears all auth session keys explicitly", () => {
    const storage = new MemoryAuthStorage()
    writeAuthToken("token", { source: "token", storage })

    clearAuthSession(storage)

    assert.equal(storage.getItem(AUTH_TOKEN_STORAGE_KEY), null)
    assert.equal(storage.getItem(AUTH_SESSION_STORAGE_KEY), null)
  })

  it("works as a no-op when browser storage is unavailable", () => {
    assert.deepEqual(readAuthToken({ storage: null }), { token: null, session: null, expired: false })
    assert.doesNotThrow(() => writeAuthToken("token", { storage: null }))
    assert.doesNotThrow(() => clearAuthSession(null))
  })

  it("generates stable non-empty token fingerprints", () => {
    assert.equal(fingerprintAuthToken("abc"), fingerprintAuthToken("abc"))
    assert.notEqual(fingerprintAuthToken("abc"), fingerprintAuthToken("abcd"))
    assert.equal(fingerprintAuthToken("abc").length > 0, true)
  })
})
