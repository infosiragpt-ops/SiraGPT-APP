import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  ProjectsServiceError,
  projectsServiceErrorCode,
} from "../lib/projects-service"

const page = readFileSync("app/code/page.tsx", "utf8")
const sidebar = readFileSync("components/sidebar/sidebar-folders-dropdown.tsx", "utf8")
const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")

test("a reloaded/sidebar Project uses the canonical workspace helper", () => {
  assert.match(page, /codexWorkspaceIdForProject/)
  assert.match(page, /projectsServiceErrorCode\(error\)/)
  assert.match(page, /data-testid="code-workspace-route-error"/)
  assert.match(sidebar, /codexProjectIdFromWorkspaceId\(opts\.folderId, \{ assumeProject: true \}\)/)
  assert.match(sidebar, /codexWorkspaceIdForProject\(projectId\)/)
  assert.match(company, /codexProjectIdFromWorkspaceId\(activeFolder\?\.id, \{ assumeProject: true \}\)/)
  assert.match(chat, /codexProjectIdFromWorkspaceId\(activeFolder\?\.id, \{ assumeProject: true \}\)/)
})

test("404s stay actionable and do not silently become a deterministic build", () => {
  const error = new ProjectsServiceError("Project not found", 404, "Project not found")
  assert.equal(projectsServiceErrorCode(error), "project_not_found")
  assert.match(page, /project_not_found/)
  assert.match(company, /data-testid="company-association-error"/)
  assert.match(company, /company_project_not_found/)
  assert.match(chat, /Entorno no disponible/)
  assert.match(chat, /Keep the active mapping intact|active mapping intact/)
})
