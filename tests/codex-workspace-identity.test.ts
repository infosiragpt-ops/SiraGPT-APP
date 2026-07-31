import assert from "node:assert/strict"
import test from "node:test"

import {
  canonicalCodexWorkspaceId,
  codexProjectIdFromWorkspaceId,
  codexWorkspaceIdForProject,
} from "../lib/codex-workspace-identity"

test("canonicalizes folder, project:<id>, and Prisma CUID references to one cloud key", () => {
  const cuid = "cmj5q0v7x0001l2abc3def456"

  assert.equal(codexProjectIdFromWorkspaceId(cuid), cuid)
  assert.equal(codexProjectIdFromWorkspaceId(`project:${cuid}`), cuid)
  assert.equal(codexWorkspaceIdForProject(cuid), `project:${cuid}`)
  assert.equal(codexWorkspaceIdForProject(`project:${cuid}`), `project:${cuid}`)
  assert.equal(canonicalCodexWorkspaceId(cuid), `project:${cuid}`)
  assert.equal(canonicalCodexWorkspaceId(`project:${cuid}`), `project:${cuid}`)
})

test("keeps local and unknown legacy workspace identities compatible", () => {
  assert.equal(canonicalCodexWorkspaceId("local:demo"), "local:demo")
  assert.equal(codexProjectIdFromWorkspaceId("local:demo"), null)
  assert.equal(canonicalCodexWorkspaceId("legacy-workspace"), "legacy-workspace")
  assert.equal(canonicalCodexWorkspaceId("legacy-workspace", { kind: "project" }), "project:legacy-workspace")
})
