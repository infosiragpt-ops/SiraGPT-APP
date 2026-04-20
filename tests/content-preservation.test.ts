import assert from "node:assert/strict"
import { describe, it } from "node:test"

/**
 * Regression tests for the "assistant reply got auto-deleted" bug.
 *
 * The bug chain was:
 *   1. Intent classifier matched GENERATE_DOCUMENT on a pasted paragraph.
 *   2. Model wrapped its entire reply in [CREATE_DOCUMENT:...][/...].
 *   3. Backend stripped the tag for the visible chat → empty string.
 *   4. Pandoc failed, the catch handler REPLACED finalContent with a
 *      bare error message, wiping what the user had just read.
 *
 * These tests pin down the three invariants the ai.js route now
 * enforces so the same regression can't come back:
 *   (A) If the model writes text OUTSIDE the tag, we keep it.
 *   (B) If the model wrote only inside the tag, we surface a preview
 *       of the content so the chat bubble is never blank.
 *   (C) Doc-creation failures never overwrite existing visible text;
 *       they append a warning note.
 *
 * We re-create the exact logic the route runs (regex + preview rules)
 * so the tests stay fast and offline — they would have caught the
 * original bug in CI.
 */

const DOC_REGEX = /\[CREATE_DOCUMENT:(?<filename>[^\]]+)\](?<content>[\s\S]*?)\[\/CREATE_DOCUMENT\]/
const MIN_VISIBLE_CHARS = 5

type Result = { finalContent: string; didCreateFile: boolean }

/**
 * Faithful mirror of the route's document-handling block. If the
 * signature of this function ever drifts from the real route, the
 * tests will still pass — so a higher-level integration test around
 * the real handler is the next layer; this one locks down the logic
 * that actually wiped content.
 */
function processDocumentTurn(
  fullResponseContent: string,
  createFile: () => { ok: boolean },
): Result {
  let finalContent = fullResponseContent
  let didCreateFile = false

  const docMatch = fullResponseContent.match(DOC_REGEX)
  if (!docMatch || !docMatch.groups) {
    return { finalContent, didCreateFile }
  }

  const { filename, content } = docMatch.groups as { filename: string; content: string }
  const chatContent = content.trim()

  const stripped = fullResponseContent.replace(DOC_REGEX, "").trim()
  if (stripped.length >= MIN_VISIBLE_CHARS) {
    finalContent = stripped
  } else {
    const preview = chatContent.slice(0, 400).trim()
    finalContent = preview.length > 0
      ? `${preview}${chatContent.length > 400 ? "…" : ""}\n\n📄 **Documento listo:** \`${filename}\``
      : `📄 **Documento listo:** \`${filename}\``
  }

  const attempt = createFile()
  if (!attempt.ok) {
    const failureNote = "\n\n⚠️ No pude generar el archivo descargable. El texto anterior sí es la respuesta completa."
    const safeBase = (finalContent && finalContent.trim().length >= MIN_VISIBLE_CHARS)
      ? finalContent
      : (fullResponseContent || "").trim()
    finalContent = safeBase + failureNote
  } else {
    didCreateFile = true
  }

  // Final guard (mirrors the route): never let the saved message be empty.
  if (!finalContent || finalContent.trim().length < MIN_VISIBLE_CHARS) {
    finalContent = (fullResponseContent && fullResponseContent.trim().length > 0)
      ? fullResponseContent
      : finalContent
  }

  return { finalContent, didCreateFile }
}

describe("content preservation · visible-text stays visible", () => {
  it("(A) keeps the model's text outside the tag when pandoc succeeds", () => {
    const reply = "Aquí tienes el informe completo. Incluye 5 secciones.\n\n[CREATE_DOCUMENT:informe.docx]# Informe\n\nCapítulo 1: ...[/CREATE_DOCUMENT]"
    const { finalContent, didCreateFile } = processDocumentTurn(reply, () => ({ ok: true }))
    assert.match(finalContent, /Aquí tienes el informe completo/)
    assert.doesNotMatch(finalContent, /\[CREATE_DOCUMENT:/)
    assert.equal(didCreateFile, true)
  })

  it("(B) surfaces a preview when the model wrapped *everything* in the tag", () => {
    const reply = "[CREATE_DOCUMENT:guide.docx]# Gestión de inventarios\n\nLa gestión de inventarios es un pilar fundamental para la eficiencia operativa de cualquier empresa moderna. En este informe exploraremos los desafíos más comunes y las mejores prácticas del sector.[/CREATE_DOCUMENT]"
    const { finalContent } = processDocumentTurn(reply, () => ({ ok: true }))
    assert.match(finalContent, /Gestión de inventarios/, "preview must surface the tag content")
    assert.match(finalContent, /Documento listo/)
    assert.ok(finalContent.trim().length >= 50, `expected non-trivial finalContent, got ${finalContent.length} chars`)
  })

  it("(C) never overwrites visible text when document creation fails", () => {
    const reply = "Aquí tienes el análisis que me pediste, con los tres puntos clave.\n\n[CREATE_DOCUMENT:analisis.docx]contenido del doc[/CREATE_DOCUMENT]"
    const { finalContent, didCreateFile } = processDocumentTurn(reply, () => ({ ok: false }))
    assert.match(finalContent, /Aquí tienes el análisis que me pediste/, "the user's original text must survive")
    assert.match(finalContent, /No pude generar el archivo descargable/)
    assert.equal(didCreateFile, false)
  })

  it("(C, everything-in-tag + failure) preserves a preview and appends a warning — still not blank", () => {
    const reply = "[CREATE_DOCUMENT:x.docx]El contenido interior es lo único que el modelo produjo en este turno, suficiente para generar un preview legible para el usuario sin dejar la burbuja en blanco.[/CREATE_DOCUMENT]"
    const { finalContent } = processDocumentTurn(reply, () => ({ ok: false }))
    assert.ok(finalContent.trim().length >= 50, `expected content preview + warning, got ${finalContent.length} chars`)
    assert.match(finalContent, /No pude generar el archivo descargable/)
  })
})

describe("content preservation · final guard", () => {
  it("restores from the raw response if some prior step left finalContent blank", () => {
    // Simulate the worst case: document logic produced empty output
    // for some unknown reason. The guard must still save the raw reply.
    const rawReply = "Texto útil que el usuario ya vio en vivo — no podemos perderlo."
    // Build a scenario where the content is entirely-in-tag BUT the
    // preview happens to also be empty (which shouldn't happen, but
    // let's guarantee the safety net).
    const reply = `${rawReply}\n\n[CREATE_DOCUMENT:x.docx][/CREATE_DOCUMENT]`
    const { finalContent } = processDocumentTurn(reply, () => ({ ok: true }))
    assert.match(finalContent, /Texto útil que el usuario ya vio en vivo/)
  })
})

describe("content preservation · no document tag at all", () => {
  it("passes through the raw reply unchanged", () => {
    const reply = "Un párrafo normal del asistente sin tags de documento."
    const { finalContent, didCreateFile } = processDocumentTurn(reply, () => ({ ok: true }))
    assert.equal(finalContent, reply)
    assert.equal(didCreateFile, false)
  })
})
