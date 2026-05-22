import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  LOCAL_DEMO_SESSION_TTL_MS,
  LOCAL_DEMO_TOKEN,
  LOCAL_DEMO_USER,
  isLocalDemoHostname,
  isLocalDemoLogin,
  localDemoAuthEnabled,
  normalizeLocalDemoEmail,
  normalizeLocalDemoHostname,
  normalizeLocalDemoPassword,
} from "../../lib/auth/local-demo-auth"

describe("local demo auth", () => {
  it("enables only local hostnames", () => {
    assert.equal(localDemoAuthEnabled("localhost"), true)
    assert.equal(localDemoAuthEnabled("LOCALHOST."), true)
    assert.equal(localDemoAuthEnabled("127.0.0.1"), true)
    assert.equal(localDemoAuthEnabled("::1"), true)
    assert.equal(localDemoAuthEnabled("siragpt.local"), true)
    assert.equal(localDemoAuthEnabled("siragpt.com"), false)
    assert.equal(localDemoAuthEnabled("admin.localhost.evil.com"), false)
  })

  it("does not enable implicitly during server-side execution", () => {
    assert.equal(localDemoAuthEnabled(), false)
  })

  it("normalizes hostname, email, and password input", () => {
    assert.equal(normalizeLocalDemoHostname(" LOCALHOST. "), "localhost")
    assert.equal(normalizeLocalDemoEmail(" Admin@Example.Com "), LOCAL_DEMO_USER.email)
    assert.equal(normalizeLocalDemoPassword("\u200B pass\tword \n"), "password")
  })

  it("accepts the documented local demo credentials on local hosts", () => {
    assert.equal(isLocalDemoLogin("admin@example.com", "password", "127.0.0.1"), true)
    assert.equal(isLocalDemoLogin(" Admin@Example.Com ", "\u200Bpassword\n", "localhost"), true)
  })

  it("rejects invalid demo credentials or production hosts", () => {
    assert.equal(isLocalDemoLogin("admin@example.com", "password", "siragpt.com"), false)
    assert.equal(isLocalDemoLogin("admin@example.com", "wrong-password", "127.0.0.1"), false)
    assert.equal(isLocalDemoLogin("user@example.com", "password", "127.0.0.1"), false)
  })

  it("keeps the demo token and user shape explicit", () => {
    assert.equal(LOCAL_DEMO_TOKEN, "local-demo-auth-token")
    assert.equal(LOCAL_DEMO_SESSION_TTL_MS, 43_200_000)
    assert.equal(LOCAL_DEMO_USER.email, "admin@example.com")
    assert.equal(LOCAL_DEMO_USER.isAdmin, true)
    assert.equal(LOCAL_DEMO_USER.isSuperAdmin, true)
    assert.equal(isLocalDemoHostname("localhost"), true)
  })
})
