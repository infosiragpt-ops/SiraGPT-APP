import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import {
  CODE_CHROME_LOCK,
  CODE_FORBIDDEN_DESKTOP_NAV_LABELS,
  CODE_FORBIDDEN_TOPBAR_ACTIONS,
  CODE_KEPT_SURFACES,
} from "../lib/code-chrome-lock"

describe("continuity guards", () => {
  it("keeps the Activos passthrough (allowlist ∪ isActive) in the catalog SSOT", () => {
    const catalog = readFileSync("backend/src/services/visible-model-catalog.js", "utf8")
    const admin = readFileSync("app/admin/models/page.tsx", "utf8")
    assert.match(catalog, /activar = visible/)
    assert.match(catalog, /const passthrough = \[\]/)
    assert.match(catalog, /isActive === false/)
    assert.match(admin, /Modelos activos/)
    assert.match(admin, /activosOpen/)
  })

  it("anchors the /code chrome lock SSOT", () => {
    assert.equal(CODE_CHROME_LOCK.showForbiddenCompanyNav, false)
    assert.equal(CODE_CHROME_LOCK.showRunPublishButtons, false)
    assert.deepEqual([...CODE_FORBIDDEN_DESKTOP_NAV_LABELS], ["Panel", "Controlar", "Archivos", "Recursos"])
    assert.deepEqual([...CODE_FORBIDDEN_TOPBAR_ACTIONS], ["Ejecutar", "Publicar"])
    assert.ok(CODE_KEPT_SURFACES.includes("Routines"))
    assert.ok(CODE_KEPT_SURFACES.includes("Computadora"))
  })

  it("keeps EmptyChat null on mobile and useResolvedMobile on /code", () => {
    const chat = readFileSync("components/code/ai-code-chat-panel.tsx", "utf8")
    const mobile = readFileSync("hooks/use-mobile.tsx", "utf8")
    assert.match(chat, /useResolvedMobile/)
    assert.match(chat, /isMobileGrok \? null/)
    assert.match(mobile, /export function useResolvedMobile/)
  })

  it("keeps the doc-engine hook, SDIE flag, ChunkLoad helper, and ACS mounts", () => {
    const edit = readFileSync("backend/src/services/source-preserving-document-edit.js", "utf8")
    const index = readFileSync("backend/index.js", "utf8")
    const sdie = readFileSync("backend/src/services/sdie/flags.js", "utf8")
    const codeError = readFileSync("app/code/error.tsx", "utf8")
    const caddy = readFileSync("deploy/Caddyfile", "utf8")
    assert.match(edit, /tryDocEngineAfterSelection/)
    assert.match(index, /\/api\/documents/)
    assert.match(index, /\/api\/agent-computer/)
    assert.match(sdie, /FEATURE_SDIE_V2/)
    assert.match(codeError, /maybeReloadStaleClientBundle/)
    assert.match(caddy, /\/agent-computer/)
  })

  it("runs the CI assert script successfully against this tree", () => {
    execFileSync("node", ["scripts/assert-continuity-guards.js"], { stdio: "pipe" })
    execFileSync("bash", ["scripts/reapply-code-ui-lock.sh", "--check"], { stdio: "pipe" })
  })
})
