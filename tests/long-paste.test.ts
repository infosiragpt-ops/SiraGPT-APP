import test from "node:test"
import assert from "node:assert/strict"

import {
  buildFileOnlyPrompt,
  buildLongPasteMetadata,
  shouldCompilePastedTextAsDocument,
} from "../lib/long-paste"

test("long paste classifier ignores normal short messages", () => {
  assert.equal(shouldCompilePastedTextAsDocument("hazme un resumen de este texto"), false)
})

test("long paste classifier compiles dense pasted content into a document", () => {
  const paragraph = "La arquitectura agentic debe interpretar intención, planificar herramientas, validar evidencias y entregar artefactos profesionales con trazabilidad completa. "
  const pasted = Array.from({ length: 18 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n")

  assert.equal(shouldCompilePastedTextAsDocument(pasted), true)
})

test("long paste metadata derives a safe title and filename", () => {
  const metadata = buildLongPasteMetadata("FACULTAD DE ARQUITECTURA\n\nContenido académico extenso.", new Date("2026-04-25T15:00:00Z"))

  assert.equal(metadata.kind, "long_paste_document")
  assert.equal(metadata.title, "FACULTAD DE ARQUITECTURA")
  assert.equal(metadata.filename, "facultad-de-arquitectura-2026-04-25T15-00-00.txt")
  assert.equal(metadata.originalLineCount, 2)
})

test("file-only prompt references compiled pasted text documents", () => {
  const metadata = buildLongPasteMetadata("FACULTAD DE ARQUITECTURA\n\nContenido académico extenso.", new Date("2026-04-25T15:00:00Z"))
  const prompt = buildFileOnlyPrompt([{ longPasteMeta: metadata }])

  assert.match(prompt, /FACULTAD DE ARQUITECTURA/)
  assert.match(prompt, /documento de texto adjunto/)
})
