import assert from "node:assert/strict"
import { describe, it, afterEach } from "node:test"
import jwt from "jsonwebtoken"
import { validateSession } from "../lib/auth"

describe("frontend validateSession", () => {
  const originalSecret = process.env.JWT_SECRET

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = originalSecret
  })

  it("fails closed when JWT_SECRET is not configured", async () => {
    delete process.env.JWT_SECRET
    const token = jwt.sign({ id: "forged-user", email: "attacker@example.com" }, "your-secret-key")

    const user = await validateSession(token)

    assert.equal(user, null)
  })

  it("accepts tokens signed with the configured secret", async () => {
    process.env.JWT_SECRET = "test-secret-with-enough-entropy-for-session-validation"
    const token = jwt.sign(
      { id: "user-1", email: "user@example.com", isAdmin: true },
      process.env.JWT_SECRET,
    )

    const user = await validateSession(token)

    assert.deepEqual(user, {
      id: "user-1",
      email: "user@example.com",
      isAdmin: true,
    })
  })
})
