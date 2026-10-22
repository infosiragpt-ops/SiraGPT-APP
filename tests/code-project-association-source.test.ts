import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  projectsServiceErrorCode,
} from "../lib/projects-service"

const page = readFileSync("app/code/page.tsx", "utf8")
const workspaceContext = readFileSync("lib/code-workspace-context.tsx", "utf8")
const sidebar = readFileSync("components/sidebar/sidebar-folders-dropdown.tsx", "utf8")
const codexApi = readFileSync("lib/codex/codex-api.ts", "utf8")
const codexApiCore = readFileSync("lib/codex/api/core.ts", "utf8")

test("a reloaded/sidebar Project uses the canonical workspace helper", () => {
  assert.match(page, /redirect\(/)
  assert.match(page, /chatSearchToAgentsHome/)
  assert.doesNotMatch(page, /CodeWorkspaceProvider|ActiveFolderHydrator/)
  assert.match(sidebar, /codexProjectIdFromWorkspaceId\(opts\.folderId, \{ assumeProject: true \}\)/)
  assert.match(sidebar, /codexWorkspaceIdForProject\(projectId\)/)
})

test("direct CodexProject routes are hydrated before launching an agent", () => {
  const directSwitch = workspaceContext.indexOf('if (target.id.startsWith("codex:"))')
  const regularSwitch = workspaceContext.indexOf('if (target.kind === "project")')
  assert.ok(directSwitch >= 0 && regularSwitch > directSwitch)
  assert.match(workspaceContext, /persistWorkspaceCodexProject\(workspaceId, project\.id\)/)
  assert.match(workspaceContext, /setActiveCodexProject\(project\.id\)/)
})

test("404s stay actionable and do not silently become a deterministic build", () => {
  const error = Object.assign(new Error("Project not found"), { status: 404 })
  assert.equal(projectsServiceErrorCode(error), "project_not_found")
  assert.match(codexApi, /codexIdentityIssue/)
  assert.match(codexApiCore, /company_project_not_found/)
})
