import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const notificationSource = readFileSync("components/notification-center.tsx", "utf8")
const permissionSource = readFileSync("backend/src/services/agent-harness/permission-manager.js", "utf8")

describe("Cowork approval inbox source contract", () => {
  it("links durable approval metadata to the global notification", () => {
    assert.match(permissionSource, /approvalId: permissionId/)
    assert.match(permissionSource, /tool: String\(toolName\)/)
  })

  it("loads pending approvals and exposes authenticated allow and deny actions", () => {
    assert.match(notificationSource, /coworkApi\.listApprovals\(\)/)
    assert.match(notificationSource, /coworkApi\.decideApproval\(approvalId, decision\)/)
    assert.match(notificationSource, /decideCoworkApproval\(notification, approvalId, "allow"\)/)
    assert.match(notificationSource, /decideCoworkApproval\(notification, approvalId, "deny"\)/)
    assert.match(notificationSource, /\bAprobar\b/)
    assert.match(notificationSource, /\bRechazar\b/)
  })

  it("keeps task links available for Cowork completion and failure notifications", () => {
    assert.match(notificationSource, /const href = actionHref\(notification\)/)
    assert.match(notificationSource, /notification\.type !== "org_invitation"/)
    assert.match(notificationSource, /\bAbrir tarea\b/)
  })
})
