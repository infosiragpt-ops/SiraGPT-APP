import assert from "node:assert/strict"
import test from "node:test"

import {
  assignedCompanySocialPlatforms,
  companySocialResourceIdentityKey,
  companySocialPlatformFromResourceKey,
  companySocialResourceAssignedToDepartment,
  companySocialResourceKey,
  companySocialResourceKeyForConnection,
  isLegacyCompanySocialResourceKey,
} from "../lib/company-resource-keys"
import type { CompanySocialProvider } from "../lib/company-social-api"

function provider(
  accountId: string | null,
  connectionId = "connection:primary",
  connected = true,
): CompanySocialProvider {
  return {
    platform: "linkedin",
    label: "LinkedIn",
    configured: true,
    scopes: [],
    supports: { text: true, remoteImage: false, generatedImage: false },
    connection: {
      id: connectionId,
      platform: "linkedin",
      accountId,
      accountName: "Cuenta",
      profile: {},
      scopes: [],
      expiresAt: null,
      updatedAt: "2026-07-27T00:00:00.000Z",
      connected,
    },
  }
}

test("social grants bind platform, connection and account identity", () => {
  const current = provider("organization/123")
  const key = companySocialResourceKey(current)

  assert.equal(
    key,
    "social:v2:linkedin:connection%3Aprimary:organization%2F123",
  )
  assert.equal(companySocialPlatformFromResourceKey(key || ""), "linkedin")
})

test("a social grant is not assignable without an active complete connection", () => {
  assert.equal(companySocialResourceKey(provider(null)), null)
  assert.equal(companySocialResourceKey(provider("account", "", true)), null)
  assert.equal(companySocialResourceKey(provider("account", "connection", false)), null)
  assert.equal(
    companySocialResourceIdentityKey(
      "linkedin",
      provider("account", "connection", false).connection,
    ),
    "social:v2:linkedin:connection:account",
  )
  assert.equal(
    companySocialResourceKeyForConnection("linkedin", {
      id: "connection",
      accountId: "account",
      connected: true,
    }),
    "social:v2:linkedin:connection:account",
  )
  assert.equal(
    companySocialResourceKeyForConnection("linkedin", {
      id: "connection",
      accountId: "\ud800",
      connected: true,
    }),
    null,
  )
})

test("legacy platform-only grants are inert", () => {
  const current = provider("account")
  const assignments = { "social:linkedin": "marketing" }

  assert.equal(isLegacyCompanySocialResourceKey("social:linkedin"), true)
  assert.equal(companySocialPlatformFromResourceKey("social:linkedin"), null)
  assert.equal(
    companySocialResourceAssignedToDepartment(assignments, current, "marketing"),
    false,
  )
  assert.deepEqual(
    assignedCompanySocialPlatforms(assignments, [current], "marketing"),
    [],
  )
})

test("changing account id requires a new explicit assignment", () => {
  const original = provider("account-a")
  const replacement = provider("account-b")
  const originalKey = companySocialResourceKey(original)
  assert.ok(originalKey)

  const assignments = { [originalKey]: "marketing" }
  assert.equal(
    companySocialResourceAssignedToDepartment(assignments, original, "marketing"),
    true,
  )
  assert.equal(
    companySocialResourceAssignedToDepartment(assignments, replacement, "marketing"),
    false,
  )
})
