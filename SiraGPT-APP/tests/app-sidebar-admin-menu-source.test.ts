import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const sidebarPath = path.join(process.cwd(), "components", "app-sidebar.tsx")
const source = fs.readFileSync(sidebarPath, "utf8")

describe("app sidebar admin menu source contract", () => {
  it("shows one admin panel entry for admins and super admins", () => {
    assert.match(
      source,
      /\(user\?\.isAdmin \|\| user\?\.isSuperAdmin\) && \(/,
      "admins and super admins should share the same admin panel entry",
    )
    assert.equal(
      source.match(/t\("adminPanel"\)/g)?.length,
      1,
      "the profile menu should expose exactly one admin panel label",
    )
  })

  it("does not expose a separate super admin panel entry", () => {
    assert.doesNotMatch(
      source,
      /t\("superAdminPanel"\)/,
      "the duplicate super admin menu item should stay hidden",
    )
  })
})
