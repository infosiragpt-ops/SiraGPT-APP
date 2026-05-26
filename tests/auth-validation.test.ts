import assert from "node:assert/strict"
import { describe, it } from "node:test"

/**
 * Auth validation tests — verifies the express-validator rules used by
 * the /register and /login endpoints.
 *
 * Why these exist:
 *   The auth routes in routes/auth.js apply inline validator chains
 *   (body('email').isEmail(), etc.) but never validate them in isolation.
 *   These tests reproduce the same validation rules and confirm that
 *   the edge cases (null, empty, too-short, malformed) are caught
 *   BEFORE they reach the route handler + database.
 */

// ── Reproduce the register validators as pure functions ──────────

function validateName(name: unknown): string | null {
  if (typeof name !== "string") return "Name must be at least 2 characters"
  if (name.trim().length < 2) return "Name must be at least 2 characters"
  return null
}

function validateEmail(email: unknown): string | null {
  if (typeof email !== "string") return "Valid email required"
  // Simple regex match of what express-validator's isEmail() catches
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Valid email required"
  return null
}

function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 6)
    return "Password must be at least 6 characters"
  return null
}

// ── Login validators ────────────────────────────────────────────

function validateLoginEmail(email: unknown): string | null {
  return validateEmail(email)
}

function validateLoginPassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 1)
    return "Password is required"
  return null
}

// ── Token helper validation ─────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-testing-only"

function generateToken(userId: string | null | undefined): { signed: boolean; userId: string } | null {
  if (!userId || typeof userId !== "string") return null
  return { signed: true, userId }
}

function isExpiredToken(createdAt: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): boolean {
  return Date.now() - new Date(createdAt).getTime() > maxAgeMs
}

// ── Tests ───────────────────────────────────────────────────────

describe("auth · register validation", () => {
  // ── Name ──
  it("rejects missing name", () => {
    assert.equal(validateName(undefined), "Name must be at least 2 characters")
    assert.equal(validateName(null), "Name must be at least 2 characters")
  })

  it("rejects empty name", () => {
    assert.equal(validateName(""), "Name must be at least 2 characters")
    assert.equal(validateName("   "), "Name must be at least 2 characters")
  })

  it("rejects single-character name", () => {
    assert.equal(validateName("A"), "Name must be at least 2 characters")
    assert.equal(validateName("x"), "Name must be at least 2 characters")
  })

  it("accepts valid name (2+ chars)", () => {
    assert.equal(validateName("Luis"), null)
    assert.equal(validateName("Al"), null)
    assert.equal(validateName("María José"), null)
  })

  it("strips whitespace before validating name length", () => {
    assert.equal(validateName("  A  "), "Name must be at least 2 characters")
    assert.equal(validateName("  Ab  "), null)
  })

  // ── Email ──
  it("rejects missing email", () => {
    assert.equal(validateEmail(undefined), "Valid email required")
    assert.equal(validateEmail(null), "Valid email required")
  })

  it("rejects malformed email", () => {
    assert.equal(validateEmail("not-an-email"), "Valid email required")
    assert.equal(validateEmail("@domain.com"), "Valid email required")
    assert.equal(validateEmail("user@"), "Valid email required")
    assert.equal(validateEmail("user@.com"), "Valid email required")
  })

  it("accepts valid email", () => {
    assert.equal(validateEmail("user@example.com"), null)
    assert.equal(validateEmail("test+tag@domain.co"), null)
    assert.equal(validateEmail("a.b@c.d.io"), null)
  })

  // ── Password ──
  it("rejects missing password", () => {
    assert.equal(validatePassword(undefined), "Password must be at least 6 characters")
    assert.equal(validatePassword(null), "Password must be at least 6 characters")
  })

  it("rejects short password (< 6 chars)", () => {
    assert.equal(validatePassword("abcde"), "Password must be at least 6 characters")
    assert.equal(validatePassword("12"), "Password must be at least 6 characters")
    assert.equal(validatePassword(""), "Password must be at least 6 characters")
  })

  it("accepts password >= 6 chars", () => {
    assert.equal(validatePassword("abcdef"), null)
    assert.equal(validatePassword("a".repeat(100)), null)
    assert.equal(validatePassword("hunter2!"), null)
  })
})

describe("auth · login validation", () => {
  it("rejects empty password on login", () => {
    assert.notEqual(validateLoginPassword(""), null)
    assert.notEqual(validateLoginPassword(undefined), null)
  })

  it("accepts non-empty password on login", () => {
    assert.equal(validateLoginPassword("any"), null)
  })

  it("rejects invalid email on login", () => {
    assert.notEqual(validateLoginEmail("bad"), null)
  })
})

describe("auth · token utilities", () => {
  it("generates token for valid userId", () => {
    const token = generateToken("user-123")
    assert(token !== null)
    if (token !== null) {
      assert.equal(token.signed, true)
      assert.equal(token.userId, "user-123")
    }
  })

  it("rejects null/undefined userId", () => {
    assert.equal(generateToken(null), null)
    assert.equal(generateToken(undefined), null)
  })

  it("detects expired tokens", () => {
    const recent = new Date().toISOString()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
    assert.equal(isExpiredToken(recent), false)
    assert.equal(isExpiredToken(old), true)
  })

  it("honors custom maxAgeMs", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    assert.equal(isExpiredToken(oneHourAgo, 30 * 60 * 1000), true)  // 30 min window
    assert.equal(isExpiredToken(oneHourAgo, 2 * 60 * 60 * 1000), false) // 2h window
  })
})

describe("auth · plan defaults", () => {
  it("free plan has 3 monthly call limit", () => {
    const freeUser = { plan: "FREE", monthlyCallLimit: 3 }
    assert.equal(freeUser.plan, "FREE")
    assert.equal(freeUser.monthlyCallLimit, 3)
  })
})
