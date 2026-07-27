import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const companySource = readFileSync("components/code/agent-company-panel.tsx", "utf8")
const previewSource = readFileSync("components/code/preview-pane.tsx", "utf8")
const socialApiSource = readFileSync("lib/company-social-api.ts", "utf8")

test("company navigation renders operational surfaces inside the preview slot", () => {
  assert.match(previewSource, /data-testid="agent-company-preview-slot"/)
  assert.match(companySource, /createPortal\([\s\S]*?<CompanyPreviewSurface/)
  assert.match(companySource, /data-testid="agent-company-preview-surface"/)
  assert.match(companySource, /data-company-view=\{view\}/)
  assert.match(companySource, /activePreviewView === "dashboard"/)
  assert.match(companySource, /activePreviewView === "control"/)
  assert.match(companySource, /activePreviewView === "files"/)
  assert.match(companySource, /activePreviewView === "resources"/)
})

test("company files and resources expose real workspace and social operations", () => {
  assert.match(companySource, /testId="company-files-surface"/)
  assert.match(companySource, /Object\.values\(files\)/)
  assert.match(companySource, /Reportes\/\$\{department\?\.name \|\| "CEO Office"\}/)
  assert.match(companySource, /testId="company-resources-surface"/)
  assert.match(companySource, /companySocialApi\.queueTextPost/)
  assert.match(companySource, /companySocialApi\.publishNow/)
  assert.match(socialApiSource, /request<\{ post: CompanySocialPost \}>\("\/queue"/)
  assert.match(socialApiSource, /encodeURIComponent\(postId\).*publish-now/)
})

test("company dashboard renders the evidence-grounded operating diagnosis", () => {
  assert.match(companySource, /proactiveResult\.value\.company/)
  assert.match(companySource, /data-testid="company-operating-diagnosis"/)
  assert.match(companySource, /companyContext\.readiness\.score/)
  assert.match(companySource, /companyContext\.profile\.mission/)
  assert.match(companySource, /companyContext\.profile\.vision/)
  assert.match(companySource, /area\.status === "ready" \? area\.evidence : area\.action/)
  assert.match(companySource, /data-testid="company-mission-portfolio"/)
  assert.match(companySource, /companyContext\.portfolio\.missions/)
  assert.match(companySource, /mission\.departmentName/)
  assert.match(companySource, /mission\.nextAction/)
})
