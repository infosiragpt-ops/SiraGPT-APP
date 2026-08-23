import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import { buildShareUrl } from "../lib/share-link"

type Globals = Record<string, unknown>

function reset() {
  const g = globalThis as Globals
  delete g.window
}

describe("lib/share-link · buildShareUrl", () => {
  afterEach(reset)

  it("usa el origen del navegador, no NEXT_PUBLIC_URL ni localhost", () => {
    const g = globalThis as Globals
    g.window = { location: { origin: "https://siragpt.com" } }
    assert.equal(
      buildShareUrl("abc-123", "chat"),
      "https://siragpt.com/share/abc-123",
    )
  })

  it("construye enlaces de mensaje individual con el segmento message/", () => {
    const g = globalThis as Globals
    g.window = { location: { origin: "https://siragpt.com" } }
    assert.equal(
      buildShareUrl("msg-9", "message"),
      "https://siragpt.com/share/message/msg-9",
    )
  })

  it("respeta un origen explícito (SSR/tests) aunque no haya window", () => {
    assert.equal(
      buildShareUrl("x1", "chat", "https://app.siragpt.com"),
      "https://app.siragpt.com/share/x1",
    )
  })

  it("codifica el shareId para que un id con caracteres especiales no rompa la URL", () => {
    assert.equal(
      buildShareUrl("a b/c", "chat", "https://siragpt.com"),
      "https://siragpt.com/share/a%20b%2Fc",
    )
  })

  it("devuelve cadena vacía si no hay origen disponible (no inventa localhost)", () => {
    assert.equal(buildShareUrl("abc", "chat"), "")
  })
})
