import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  projectsServiceErrorCode,
} from "../lib/projects-service"

const page = readFileSync("app/code/page.tsx", "utf8")
const workspaceContext = readFileSync("lib/code-workspace-context.tsx", "utf8")
const sidebar = readFileSync("components/sidebar/sidebar-folders-dropdown.tsx", "utf8")
const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
const codexApi = readFileSync("lib/codex/codex-api.ts", "utf8")
const codexApiCore = readFileSync("lib/codex/api/core.ts", "utf8")
const workspaceRoute = readFileSync("lib/code-workspace-route.ts", "utf8")

test("a reloaded/sidebar Project uses the canonical workspace helper", () => {
  assert.match(page, /data-testid="code-workspace-route-error"/)
  assert.doesNotMatch(page, /const workspaceId = localId \|\| \(folderId \? `project:\$\{folderId\}`/)
  assert.match(page, /hydratedFolderRef\.current = null/)
  assert.match(page, /setHydrationAttempt\(\(attempt\) => attempt \+ 1\)/)
  assert.match(page, /resolveCodeWorkspaceFolder\([\s\S]*projectsService\.get,[\s\S]*codexApi\.getProject/)
  assert.match(page, /persistWorkspaceCodexProject\(workspaceId, project\.id\)/)
  assert.match(page, /setActiveCodexProject\(directCodexProject \? project\.id : null\)/)
  assert.match(workspaceRoute, /folderId\.replace\(\/\^\\w\+:\//)
  assert.match(workspaceRoute, /getProject\(projectId\)[\s\S]*status\?[\s\S]*getCodexProject/)
  assert.match(page, /classifyWorkspaceError\(error\)/)
  assert.match(
    page,
    /classified\.status === 404 \|\| classified\.code === "WORKSPACE_NOT_FOUND"[\s\S]*setRouteIssue\(1\)/,
  )
  assert.match(sidebar, /codexProjectIdFromWorkspaceId\(opts\.folderId, \{ assumeProject: true \}\)/)
  assert.match(sidebar, /codexWorkspaceIdForProject\(projectId\)/)
  assert.match(company, /codexProjectIdFromWorkspaceId\(activeFolder\?\.id, \{ assumeProject: true \}\)/)
  assert.match(chat, /codexProjectIdFromWorkspaceId\(activeFolder\?\.id, \{ assumeProject: true \}\)/)
})

test("direct CodexProject routes are hydrated before launching an agent", () => {
  assert.match(page, /hydratedFolderRef\.current !== folderId/)
  assert.match(page, /const workspaceId = localId \|\| activeFolder\?\.id \|\| null/)
  assert.match(page, /workspaceId\.replace\(\/\^\(\?:project\|codex\|local\):\//)
  const directSwitch = workspaceContext.indexOf('if (target.id.startsWith("codex:"))')
  const regularSwitch = workspaceContext.indexOf('if (target.kind === "project")')
  assert.ok(directSwitch >= 0 && regularSwitch > directSwitch)
  assert.match(workspaceContext, /persistWorkspaceCodexProject\(workspaceId, project\.id\)/)
  assert.match(workspaceContext, /setActiveCodexProject\(project\.id\)/)
})

test("404s stay actionable and do not silently become a deterministic build", () => {
  const error = Object.assign(new Error("Project not found"), { status: 404 })
  assert.equal(projectsServiceErrorCode(error), "project_not_found")
  assert.match(page, /setRouteIssue\(1\)/)
  assert.match(company, /data-testid="company-association-error"/)
  assert.match(company, /codexIdentityIssue\(error\)/)
  assert.match(codexApi, /codexIdentityIssue/)
  assert.match(codexApiCore, /company_project_not_found/)
  assert.match(chat, /Entorno no disponible/)
  assert.match(chat, /Keep the active mapping intact|active mapping intact/)
})

test("association-required is an identity block with an association CTA, never a build fallback", () => {
  const required = chat.indexOf('errorCode === "company_association_required"')
  const fallback = chat.indexOf("Project provisioning / plan-run error during a BUILD")
  assert.ok(required >= 0 && fallback > required)
  assert.match(chat, /data-testid="code-identity-error"/)
  assert.match(chat, /CODE_OPEN_COMPANY_ASSOCIATION_EVENT/)
  assert.match(chat, /CODE_COMPANY_ASSOCIATION_CHANGED_EVENT/)
  assert.match(chat, /setCompanyAssociationResolved\(true\)/)
  assert.match(
    chat,
    /codexAvailable && \(!companyWorkspace \|\| companyAssociationResolved\)/,
  )
  assert.match(chat, /associationEpoch/)
  assert.match(company, /window\.addEventListener\(CODE_OPEN_COMPANY_ASSOCIATION_EVENT/)
  assert.match(company, /notifyCompanyAssociationChanged\(\)/)
})
