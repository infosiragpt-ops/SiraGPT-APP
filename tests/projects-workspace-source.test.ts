import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const root = process.cwd()
const listPage = fs.readFileSync(path.join(root, "app/projects/page.tsx"), "utf8")
const detailPage = fs.readFileSync(path.join(root, "app/projects/[id]/page.tsx"), "utf8")
const createDialog = fs.readFileSync(path.join(root, "components/projects/create-project-dialog.tsx"), "utf8")

describe("professional project workspace source contract", () => {
  it("opens the create-project dialog instead of sending new projects to /code", () => {
    assert.match(listPage, /CreateProjectDialog/)
    assert.match(listPage, /setCreateOpen\(true\)/)
    assert.match(listPage, /\/projects\/\$\{project\.id\}/)
    assert.doesNotMatch(listPage, /codeWorkspaceHref/)
    assert.doesNotMatch(listPage, /\/code\?folder=/)
  })

  it("keeps the Claude-style create form: name, goal, and Usar una carpeta", () => {
    assert.match(createDialog, /data-testid="project-use-folder"/)
    assert.match(createDialog, /t\("useFolder"\)/)
    assert.match(createDialog, /t\("createTitle"\)/)
    assert.match(createDialog, /webkitdirectory/)
    assert.match(createDialog, /type: "general"/)
  })

  it("renders the project workspace with knowledge rail and scheduled tasks", () => {
    assert.match(detailPage, /ProjectKnowledgeRail/)
    assert.match(detailPage, /data-testid="project-knowledge-rail"/)
    assert.match(detailPage, /t\("knowledgeHint"\)/)
    assert.match(detailPage, /t\("chatMode"\)/)
    assert.match(detailPage, /t\("cowork"\)/)
    assert.match(detailPage, /ScheduledTaskDialog/)
    assert.match(detailPage, /TextContentDialog/)
    assert.doesNotMatch(detailPage, /project-context-card/)
    assert.doesNotMatch(detailPage, /respuestas de Claude/)
  })
})
