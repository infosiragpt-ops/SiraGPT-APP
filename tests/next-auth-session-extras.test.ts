import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import jwt from "jsonwebtoken"

import { validateSession } from "../lib/auth"

/**
 * Extras for the frontend validateSession. Pins:
 *
 *   - Empty/whitespace JWT_SECRET treated as missing (fail closed)
 *   - decoded.id vs decoded.userId fallback
 *   - missing id field -> null
 *   - isAdmin coerced via Boolean(...)
 *   - email defaults to "" when missing
 *   - Expired token / wrong-secret token -> null (catch-all)
 *   - Garbage / non-JWT input -> null
 */

const ORIGINAL_SECRET = process.env.JWT_SECRET

describe("validateSession · secret edge cases", () => {
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = ORIGINAL_SECRET
  })

  it("returns null when JWT_SECRET is empty string", async () => {
    process.env.JWT_SECRET = ""
    const out = await validateSession(
      jwt.sign({ id: "u1" }, "anything"),
    )
    assert.equal(out, null)
  })

  it("returns null when JWT_SECRET is whitespace-only", async () => {
    process.env.JWT_SECRET = "   "
    const out = await validateSession(
      jwt.sign({ id: "u1" }, "anything"),
    )
    assert.equal(out, null)
  })
})

describe("validateSession · payload shapes", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-for-payload-shapes-tests-123456789"
  })

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = ORIGINAL_SECRET
  })

  it("uses decoded.userId when decoded.id is missing", async () => {
    const token = jwt.sign({ userId: "u-via-userId" }, process.env.JWT_SECRET!)
    const user = await validateSession(token)
    assert.equal(user?.id, "u-via-userId")
  })

  it("returns null when both id and userId are missing", async () => {
    const token = jwt.sign({ email: "x@example.com" }, process.env.JWT_SECRET!)
    const user = await validateSession(token)
    assert.equal(user, null)
  })

  it("coerces isAdmin via Boolean() (truthy -> true)", async () => {
    const token = jwt.sign(
      { id: "u1", email: "x@x", isAdmin: 1 as unknown as boolean },
      process.env.JWT_SECRET!,
    )
    const user = await validateSession(token)
    assert.equal(user?.isAdmin, true)
  })

  it("isAdmin defaults to false when missing", async () => {
    const token = jwt.sign({ id: "u1", email: "x@x" }, process.env.JWT_SECRET!)
    const user = await validateSession(token)
    assert.equal(user?.isAdmin, false)
  })

  it("email defaults to '' when missing", async () => {
    const token = jwt.sign({ id: "u1" }, process.env.JWT_SECRET!)
    const user = await validateSession(token)
    assert.equal(user?.email, "")
  })
})

describe("validateSession · invalid tokens", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-for-invalid-tokens-987654321"
  })

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = ORIGINAL_SECRET
  })

  it("returns null for a token signed with a different secret", async () => {
    const forged = jwt.sign({ id: "attacker" }, "wrong-secret")
    assert.equal(await validateSession(forged), null)
  })

  it("returns null for an expired token", async () => {
    const token = jwt.sign(
      { id: "u1", exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET!,
    )
    assert.equal(await validateSession(token), null)
  })

  it("returns null for garbage / non-JWT input", async () => {
    assert.equal(await validateSession("not-a-jwt"), null)
    assert.equal(await validateSession(""), null)
    assert.equal(await validateSession("aaa.bbb.ccc"), null)
  })
})
