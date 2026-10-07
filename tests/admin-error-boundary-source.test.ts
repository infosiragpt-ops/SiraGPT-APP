import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const source = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")

/**
 * «No se pudo cargar el admin · Reintentar / Ir a /admin» right after a
 * publish: the /admin boundary ignored stale-bundle errors (ChunkLoadError)
 * that the global boundary already auto-reloaded, and it reported nothing to
 * telemetry. Both boundaries now share lib/client-bundle-recovery.
 */
describe("route error boundaries share the stale-bundle recovery", () => {
  const admin = source("app/admin/error.tsx")
  const global = source("app/error.tsx")

  it("/admin reloads once for a stale bundle and explains the new version instead of a dead «Reintentar»", () => {
    assert.match(admin, /import \{ isRecoverableClientBundleError, reloadOnceForStaleBundle \} from "@\/lib\/client-bundle-recovery"/)
    assert.match(admin, /reloadOnceForStaleBundle\(error\)/)
    assert.match(admin, /const staleBundle = isRecoverableClientBundleError\(error\)/)
    assert.match(admin, /Hay una versión nueva de SiraGPT/)
    assert.match(admin, /window\.location\.reload\(\)/)
    assert.match(admin, /staleBundle \? "Recargar"/)
    assert.match(admin, /No se pudo cargar el admin/)
    assert.match(admin, /Ir a \/admin/)
  })

  it("/admin reports render errors to analytics and the server telemetry pipeline", () => {
    assert.match(admin, /import \{ track \} from "@\/lib\/analytics"/)
    assert.match(admin, /import \{ reportClientLog \} from "@\/lib\/client-logs"/)
    assert.match(admin, /track\("error\.route", \{\s*area: "admin"/)
    assert.match(admin, /reportClientLog\(\{\s*source: "render",\s*severity: "error",\s*action: "error\.route"/)
    assert.match(admin, /if \(staleBundle\) return\s*reportClientLog/, "stale-bundle errors auto-reload and are not reported as failures")
  })

  it("the global boundary uses the same helper and no longer keeps a private copy of the detector", () => {
    assert.match(global, /import \{ isRecoverableClientBundleError, reloadOnceForStaleBundle \} from "@\/lib\/client-bundle-recovery"/)
    assert.match(global, /reloadOnceForStaleBundle\(error\)/)
    assert.doesNotMatch(global, /function isRecoverableClientBundleError/)
    assert.doesNotMatch(global, /__siragpt_stale_reload__/)
    assert.match(global, /if \(isRecoverableClientBundleError\(error\)\) return/)
  })
})
