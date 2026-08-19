import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getAuthRedirect } from "../lib/auth/auth-guard-rules"

describe("getAuthRedirect", () => {
  it("redirects anonymous users to login", () => {
    assert.equal(getAuthRedirect(null), "/auth/login")
  })

  it("allows regular authenticated users on non-admin routes", () => {
    assert.equal(getAuthRedirect({ isAdmin: false, isSuperAdmin: false }), null)
  })

  it("redirects non-admin users away from admin routes", () => {
    assert.equal(getAuthRedirect({ isAdmin: false, isSuperAdmin: false }, { requireAdmin: true }), "/chat")
  })

  it("allows admin users on admin routes", () => {
    assert.equal(getAuthRedirect({ isAdmin: true, isSuperAdmin: false }, { requireAdmin: true }), null)
  })

  it("redirects admins away from super-admin-only routes", () => {
    assert.equal(getAuthRedirect({ isAdmin: true, isSuperAdmin: false }, { requireSuperAdmin: true }), "/chat")
  })

  it("allows super admins everywhere", () => {
    assert.equal(
      getAuthRedirect({ isAdmin: false, isSuperAdmin: true }, { requireAdmin: true, requireSuperAdmin: true }),
      null
    )
  })
})
