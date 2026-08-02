import assert from "node:assert/strict"
import test from "node:test"

import { resolveCodeWorkspaceFolder } from "../lib/code-workspace-route"

const project = {
  id: "cms3regularproject000000000",
  name: "Empresa regular",
  description: "Contexto",
  instructions: "Opera con revisión",
}
const codexProject = {
  id: "cms2directcodex0000000000",
  name: "Prueba gates 02 · Empresa",
}

test("uses the backend Project resolution without another browser-side probe", async () => {
  let calls = 0
  const resolved = await resolveCodeWorkspaceFolder(project.id, async (folderId) => {
    calls += 1
    assert.equal(folderId, project.id)
    return {
      kind: "project" as const,
      workspaceId: `project:${project.id}`,
      project,
    }
  })

  assert.equal(resolved[0], false)
  assert.equal(resolved[1].id, project.id)
  assert.equal(calls, 1)
})

test("uses the authoritative CodexProject fallback returned for a bare id", async () => {
  const resolved = await resolveCodeWorkspaceFolder(codexProject.id, async () => ({
    kind: "codex" as const,
    workspaceId: `codex:${codexProject.id}`,
    project: codexProject,
  }))

  assert.equal(resolved[0], true)
  assert.equal(resolved[1].id, codexProject.id)
})

test("preserves backend 404 and transient failures", async () => {
  const notFound = Object.assign(new Error("not found"), { status: 404 })
  await assert.rejects(
    resolveCodeWorkspaceFolder(project.id, async () => {
      throw notFound
    }),
    notFound,
  )

  const outage = Object.assign(new Error("temporarily unavailable"), { status: 503 })
  await assert.rejects(
    resolveCodeWorkspaceFolder(project.id, async () => {
      throw outage
    }),
    outage,
  )
})

test("fails closed when the backend identity and project payload disagree", async () => {
  await assert.rejects(
    resolveCodeWorkspaceFolder(project.id, async () => ({
      kind: "project" as const,
      workspaceId: `project:${codexProject.id}`,
      project,
    })),
    (error: unknown) => (
      (error as { status?: number; code?: string }).status === 502
      && (error as { code?: string }).code === "workspace_identity_mismatch"
    ),
  )
})
