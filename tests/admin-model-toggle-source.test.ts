import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const pageSource = readFileSync("app/admin/models/page.tsx", "utf8")

function toggleHandlerSource() {
  const match = pageSource.match(
    /const toggleModelStatus = async[\s\S]*?\n\s*\/\/ Filter models based on search and filters/,
  )
  assert.ok(match, "toggleModelStatus handler must exist")
  return match[0]
}

describe("admin model activation contract", () => {
  it("uses same-origin PATCH with an explicit boolean payload", () => {
    assert.match(pageSource, /getSameOriginApiBaseUrl/)
    const handler = toggleHandlerSource()

    assert.match(handler, /authenticatedFetch\(`\$\{API_ROOT\}\/admin\/models\/\$\{encodeURIComponent\(modelId\)\}`/)
    assert.match(handler, /method:\s*["']PATCH["']/)
    assert.match(handler, /body:\s*JSON\.stringify\(\{\s*isActive:\s*next\s*\}\)/)
  })

  it("keeps the optimistic update, in-flight disable, rollback, and Spanish error", () => {
    const handler = toggleHandlerSource()

    assert.match(handler, /togglingIdsRef\.current\.has\(modelId\)/)
    assert.match(handler, /setTogglingIds/)
    assert.match(handler, /isActive:\s*next/)
    assert.match(handler, /if \(!response\.ok\)/)
    assert.match(handler, /isActive:\s*currentStatus/)
    assert.match(handler, /togglingIdsRef\.current\.delete\(modelId\)/)
    assert.match(handler, /No se pudo actualizar el modelo/)
    assert.match(pageSource, /Solo los administradores pueden activar o desactivar modelos/)
  })
})
