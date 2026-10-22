import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
const workspaceSource = readFileSync("lib/code-workspace-context.tsx", "utf8")
const socialApiSource = readFileSync("lib/company-social-api.ts", "utf8")
const resourceKeysSource = readFileSync("lib/company-resource-keys.ts", "utf8")
const codexApiSource = [
  readFileSync("lib/codex/api/company-associations.ts", "utf8"),
  readFileSync("lib/codex/api/company.ts", "utf8"),
].join("\n")
const postPageSource = readFileSync("app/post/page.tsx", "utf8")

test("company files and resources expose real workspace and social operations", () => {
  assert.match(resourceKeysSource, /social:v2:/)
  assert.match(resourceKeysSource, /encodeURIComponent\(connectionId\)/)
  assert.match(resourceKeysSource, /encodeURIComponent\(accountId\)/)
  assert.match(resourceKeysSource, /isLegacyCompanySocialResourceKey/)
  assert.match(codexApiSource, /expectedRevision: resources\.revision/)
  assert.match(codexApiSource, /addCompanyConnector/)
  assert.match(socialApiSource, /request<\{ post: CompanySocialPost \}>\("\/queue"/)
  assert.match(socialApiSource, /encodeURIComponent\(postId\).*publish-now/)
})

test("automatic post series remain scoped to the active company and literal Marketing resources", () => {
  assert.match(postPageSource, /getActiveCodexProject/)
  assert.match(postPageSource, /codexApi\.getCompanyResources\(activeWorkspaceId\)/)
  assert.match(postPageSource, /companySocialResourceKeyForConnection/)
  assert.match(postPageSource, /resources\?\.assignments\?\.\[resourceKey\] === "marketing"/)
  assert.match(postPageSource, /workspaceId,/)
  assert.match(postPageSource, /social-posts\?workspaceId=/)
  assert.match(postPageSource, /loadGenerationRef/)
  assert.match(postPageSource, /loadAbortRef/)
  assert.match(postPageSource, /companySocialApi\.legacySummary\(activeWorkspaceId\)/)
  assert.match(postPageSource, /companySocialApi\.assignLegacyPosts\(workspaceId\)/)
  assert.match(postPageSource, /Publicaciones anteriores sin empresa/)
  assert.match(postPageSource, /ninguna se publicará automáticamente/i)
  assert.match(postPageSource, /legacyLoadError/)
  assert.match(postPageSource, /No se realizará ninguna asignación/)
  assert.match(postPageSource, /window\.confirm/)
  assert.match(socialApiSource, /\/legacy\?workspaceId=/)
  assert.match(socialApiSource, /request<CompanySocialLegacyAssignment>\("\/legacy\/assign"/)
  assert.match(socialApiSource, /confirm: true/)
  assert.match(postPageSource, /connect\/\$\{network\.id\}\?redirect=1/)
  assert.doesNotMatch(postPageSource, /id: "instagram"/)
  assert.doesNotMatch(postPageSource, /id: "youtube"/)
})

test("company dashboard renders the evidence-grounded operating diagnosis", () => {
  assert.match(codexApiSource, /getCompanyOkrs/)
  assert.match(codexApiSource, /reviewCompanyOkrs/)
  assert.match(codexApiSource, /reprioritizeCompanyOkrs/)
})

test("company runtime identity is durable and legacy browser links are confirmation hints only", () => {
  assert.match(codexApiSource, /getCompanyAssociation/)
  assert.match(codexApiSource, /associateCompany/)
  assert.match(codexApiSource, /assignCompanyConnectors/)
  assert.match(workspaceSource, /durable Project ↔ CodexProject association/)
})
