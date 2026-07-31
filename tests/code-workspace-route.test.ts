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

function notFound(): Error {
  return Object.assign(new Error("not found"), { status: 404, code: "project_not_found" })
}

test("prefers a regular Project when the bare id exists in both domains", async () => {
  let codexCalls = 0
  const resolved = await resolveCodeWorkspaceFolder(
    project.id,
    async () => project,
    async () => {
      codexCalls += 1
      return codexProject
    },
  )

  assert.equal(resolved[0], false)
  assert.equal(resolved[1].id, project.id)
  assert.equal(codexCalls, 0)
})

test("falls back from a bare Project 404 to the matching CodexProject", async () => {
  const resolved = await resolveCodeWorkspaceFolder(
    codexProject.id,
    async () => {
      throw notFound()
    },
    async (id) => ({ ...codexProject, id }),
  )

  assert.equal(resolved[0], true)
  assert.equal(resolved[1].id, codexProject.id)
})

test("an explicit codex workspace never probes the regular Project endpoint", async () => {
  let projectCalls = 0
  const resolved = await resolveCodeWorkspaceFolder(
    `codex:${codexProject.id}`,
    async () => {
      projectCalls += 1
      return project
    },
    async () => codexProject,
  )

  assert.equal(resolved[0], true)
  assert.equal(projectCalls, 0)
})

test("does not hide a transient regular Project failure behind Codex fallback", async () => {
  let codexCalls = 0
  const outage = Object.assign(new Error("temporarily unavailable"), { status: 503 })

  await assert.rejects(
    resolveCodeWorkspaceFolder(
      project.id,
      async () => {
        throw outage
      },
      async () => {
        codexCalls += 1
        return codexProject
      },
    ),
    outage,
  )
  assert.equal(codexCalls, 0)
})
