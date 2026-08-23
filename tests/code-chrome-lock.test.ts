import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  CODE_CHROME_LOCK,
  isForbiddenCompanyNavLabel,
  isForbiddenTopBarAction,
} from "../lib/code-chrome-lock"

describe("code chrome lock", () => {
  it("classifies the historical VPS-hidden labels", () => {
    assert.equal(isForbiddenCompanyNavLabel("Panel"), true)
    assert.equal(isForbiddenCompanyNavLabel("Controlar"), true)
    assert.equal(isForbiddenTopBarAction("Ejecutar"), true)
    assert.equal(isForbiddenTopBarAction("Publicar"), true)
    assert.equal(isForbiddenCompanyNavLabel("Routines"), false)
    assert.equal(isForbiddenTopBarAction("Computadora"), false)
  })

  it("gates company nav and run/publish behind the SSOT flags", () => {
    const company = readFileSync("components/code/agent-company-panel.tsx", "utf8")
    const topbar = readFileSync("components/code/workspace-top-bar.tsx", "utf8")
    const workspace = readFileSync("components/code/code-workspace.tsx", "utf8")
    assert.match(company, /CODE_CHROME_LOCK.showForbiddenCompanyNav/)
    assert.match(company, /data-testid="code-routines-slot"/)
    assert.match(topbar, /CODE_CHROME_LOCK.showRunPublishButtons/)
    assert.match(topbar, /workspace-header-department-computer/)
    assert.match(workspace, /hideDesktopTopBarOnPhone/)
    assert.match(workspace, /DepartmentComputerPane|CodeMobileComputerOverlay/)
    assert.equal(CODE_CHROME_LOCK.hideDesktopTopBarOnPhone, true)
  })
})
