import assert from "node:assert/strict"
import test from "node:test"

import {
  canonicalCodexWorkspaceId,
  codexProjectIdFromWorkspaceId,
  codexWorkspaceIdForProject,
  isSameCodexWorkspace,
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

test("agent launch keeps a project:<cuid> URL canonical and sends the bare id", () => {
  const folder = "project:cms2abcdefghijklmnopqrstuv"
  const projectId = codexProjectIdFromWorkspaceId(folder, { assumeProject: true })
  assert.equal(projectId, "cms2abcdefghijklmnopqrstuv")
  assert.equal(codexWorkspaceIdForProject(projectId), folder)
})

test("keeps local and unknown legacy workspace identities compatible", () => {
  assert.equal(canonicalCodexWorkspaceId("local:demo"), "local:demo")
  assert.equal(codexProjectIdFromWorkspaceId("local:demo"), null)
  assert.equal(canonicalCodexWorkspaceId("legacy-workspace"), "legacy-workspace")
  assert.equal(canonicalCodexWorkspaceId("legacy-workspace", { kind: "project" }), "project:legacy-workspace")
})

test("keeps direct CodexProject workspaces outside the company Project namespace", () => {
  const cuid = "cms2abcdefghijklmnopqrstuv"
  const workspaceId = `codex:${cuid}`

  assert.equal(workspaceId, `codex:${cuid}`)
  assert.equal(codexProjectIdFromWorkspaceId(workspaceId, { assumeProject: true }), null)
  assert.equal(canonicalCodexWorkspaceId(workspaceId), workspaceId)
})

test("matches raw and canonical Project workspace ids without crossing namespaces", () => {
  assert.equal(isSameCodexWorkspace("matrix-qa", "project:matrix-qa"), true)
  assert.equal(isSameCodexWorkspace("project:matrix-qa", "matrix-qa"), true)
  assert.equal(isSameCodexWorkspace("local:matrix-qa", "project:matrix-qa"), false)
  assert.equal(isSameCodexWorkspace("codex:matrix-qa", "project:matrix-qa"), false)
  assert.equal(isSameCodexWorkspace("codex:matrix-qa", "codex:other"), false)
})
