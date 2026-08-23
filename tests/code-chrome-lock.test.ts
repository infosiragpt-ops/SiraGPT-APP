import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  CODE_CHROME_LOCK,
  isForbiddenCompanyNavLabel,
  isForbiddenTopBarAction,
  isKeptSurface,
} from "../lib/code-chrome-lock"

describe("code chrome lock", () => {
  it("forbids the annotated home-nav labels and the Arrancando run control", () => {
    assert.equal(isForbiddenCompanyNavLabel("Panel"), true)
    assert.equal(isForbiddenCompanyNavLabel("Controlar"), true)
    assert.equal(isForbiddenCompanyNavLabel("Archivos"), true)
    assert.equal(isForbiddenCompanyNavLabel("Recursos"), true)
    assert.equal(isForbiddenTopBarAction("Ejecutar"), true)
    assert.equal(isForbiddenTopBarAction("Detener"), true)
    assert.equal(isForbiddenTopBarAction("Arrancando"), true)
    assert.equal(isForbiddenTopBarAction("Arrancando…"), true)
    assert.equal(isForbiddenCompanyNavLabel("Routines"), false)
    assert.equal(isForbiddenTopBarAction("Publicar"), false)
    assert.equal(isForbiddenTopBarAction("Computadora"), false)
    assert.equal(isKeptSurface("Publicar"), true)
    assert.equal(isKeptSurface("Routines"), true)
    assert.equal(isKeptSurface("Computadora"), true)
    assert.equal(CODE_CHROME_LOCK.showForbiddenCompanyNav, false)
    assert.equal(CODE_CHROME_LOCK.showHeaderRunStopButton, false)
    assert.equal(CODE_CHROME_LOCK.keepPublishButton, true)
  })

  it("keeps Publicar / Routines / Computadora and strips Arrancando from source", () => {
    const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
    const topbar = readFileSync("components/code/workspace-top-bar.tsx", "utf8")
    const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
    const workspace = readFileSync("components/code/code-workspace.tsx", "utf8")
    const script = readFileSync("scripts/reapply-code-ui-lock.sh", "utf8")

    assert.match(company, /CODE_CHROME_LOCK\.showForbiddenCompanyNav/)
    assert.match(company, /data-testid="code-routines-slot"/)
    assert.doesNotMatch(company, /label="Panel"/)
    assert.doesNotMatch(company, /label="Controlar"/)
    assert.doesNotMatch(company, /label="Archivos"/)
    assert.doesNotMatch(company, /label="Recursos"/)

    assert.match(topbar, /CODE_CHROME_LOCK\.keepPublishButton/)
    assert.match(topbar, /workspace-header-department-computer/)
    assert.match(topbar, /bg-zinc-900/)
    assert.match(topbar, /Publicar/)
    assert.doesNotMatch(topbar, /workspace-header-run-stop/)
    assert.doesNotMatch(topbar, /Arrancando/)

    assert.match(chat, /function EmptyChat/)
    assert.match(chat, /function EmptyChat[\s\S]{0,400}return null/)

    assert.match(workspace, /DepartmentComputerPane|CodeMobileComputerOverlay|onOpenDepartmentComputer/)

    assert.doesNotMatch(script, /cd\s+--/)
    assert.match(script, /for arg in "\$@"/)
  })
})
