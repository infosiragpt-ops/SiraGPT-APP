import test from "node:test"
import assert from "node:assert/strict"

import {
  describeStage,
  friendlyFailureLabel,
  isTerminalStage,
  TERMINAL_STAGES,
} from "../lib/file-processing-vocab"

test("TERMINAL_STAGES contains exactly the two terminal stages", () => {
  assert.equal(TERMINAL_STAGES.has("ready"), true)
  assert.equal(TERMINAL_STAGES.has("failed"), true)
  assert.equal(TERMINAL_STAGES.has("extracting"), false)
  assert.equal(TERMINAL_STAGES.has("uploaded"), false)
  assert.equal(TERMINAL_STAGES.size, 2)
})

test("isTerminalStage matches the TERMINAL_STAGES set", () => {
  assert.equal(isTerminalStage("ready"), true)
  assert.equal(isTerminalStage("failed"), true)
  assert.equal(isTerminalStage("uploaded"), false)
  assert.equal(isTerminalStage("indexing"), false)
  assert.equal(isTerminalStage(null), false)
  assert.equal(isTerminalStage(undefined), false)
})

test("describeStage returns the canonical Spanish label per stage", () => {
  assert.deepEqual(describeStage("uploaded"),   { label: "Subido",            tone: "progress" })
  assert.deepEqual(describeStage("validating"), { label: "Validando",         tone: "progress" })
  assert.deepEqual(describeStage("extracting"), { label: "Extrayendo texto",  tone: "progress" })
  assert.deepEqual(describeStage("chunking"),   { label: "Fragmentando",      tone: "progress" })
  assert.deepEqual(describeStage("embedding"),  { label: "Indexando",         tone: "progress" })
  assert.deepEqual(describeStage("indexing"),   { label: "Indexando",         tone: "progress" })
  assert.deepEqual(describeStage("ready"),      { label: "Listo",             tone: "success"  })
})

test("describeStage(null) returns the neutral 'Pendiente' default", () => {
  assert.deepEqual(describeStage(null), { label: "Pendiente", tone: "neutral" })
})

test("describeStage('failed') routes through friendlyFailureLabel for the prefix mapping", () => {
  const cases: Array<[string, string]> = [
    ["magic_byte_mismatch: real=application/x-msdownload", "Tipo de archivo no permitido"],
    ["processing: ENOENT: no such file",                    "No se pudo procesar el documento"],
    ["rag_indexing: Qdrant unreachable",                    "Error al indexar el documento"],
    ["db_create_failed: connection refused",                "No se pudo registrar el archivo"],
  ]
  for (const [raw, expected] of cases) {
    const desc = describeStage("failed", raw)
    assert.equal(desc.tone, "error")
    assert.equal(desc.label, expected, `prefix mapping for '${raw}' should be '${expected}'`)
  }
})

test("describeStage('failed') with no error uses the generic fallback label", () => {
  assert.deepEqual(describeStage("failed", null),       { label: "Error de procesamiento", tone: "error" })
  assert.deepEqual(describeStage("failed", undefined),  { label: "Error de procesamiento", tone: "error" })
  assert.deepEqual(describeStage("failed", ""),         { label: "Error de procesamiento", tone: "error" })
  assert.deepEqual(describeStage("failed", "   "),      { label: "Error de procesamiento", tone: "error" })
})

test("friendlyFailureLabel preserves an unknown reason verbatim (real OCR/parser signal)", () => {
  const raw = "Out of memory while OCR-ing 380-page PDF"
  assert.equal(friendlyFailureLabel(raw), raw)
})

test("friendlyFailureLabel is case-insensitive on the prefix match", () => {
  assert.equal(friendlyFailureLabel("MAGIC_BYTE_MISMATCH: foo"), "Tipo de archivo no permitido")
  assert.equal(friendlyFailureLabel("Processing: ECONNRESET"),    "No se pudo procesar el documento")
  assert.equal(friendlyFailureLabel("RAG_INDEXING: 503 service"), "Error al indexar el documento")
})
