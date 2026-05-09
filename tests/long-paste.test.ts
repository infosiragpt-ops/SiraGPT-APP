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

test("long paste classifier compiles content above the MIN_LINES threshold", () => {
  const twentyLines = Array.from({ length: 20 }, (_, i) => `linea ${i + 1}`).join("\n")
  const twentyOneLines = Array.from({ length: 21 }, (_, i) => `linea ${i + 1}`).join("\n")

  assert.equal(shouldCompilePastedTextAsDocument(twentyLines), true, "20 líneas alcanzan el umbral (MIN_LINES=20)")
  assert.equal(shouldCompilePastedTextAsDocument(twentyOneLines), true, "21 líneas deben convertirse en documento")
})

test("long paste classifier ignores blank lines when counting", () => {
  // 19 non-empty lines separated by blanks → under the threshold (20).
  // Prevents accidental triggers from double-spaced short messages.
  const padded = Array.from({ length: 19 }, (_, i) => `linea ${i + 1}`).join("\n\n")
  assert.equal(shouldCompilePastedTextAsDocument(padded), false)
})

test("long paste classifier detects structural content (academic/research)", () => {
  // Academic content with strong structure but under the character threshold
  const academic = `ABSTRACT\n\nThis study examines the relationship between X and Y.\n\nINTRODUCTION\n\nThe field has grown significantly in recent years.\n\nMETHODOLOGY\n\nWe employed a mixed-methods approach.\n\nRESULTS\n\nTable 1 shows the correlation.\n\nDISCUSSION\n\nThese findings suggest...\n\nREFERENCES\n\n[1] Smith, J. (2020). Title. Journal.\n[2] Doe, A. (2021). Another study. Conference.`

  assert.equal(shouldCompilePastedTextAsDocument(academic), true, "contenido academico con estructura debe ser detectado")
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
