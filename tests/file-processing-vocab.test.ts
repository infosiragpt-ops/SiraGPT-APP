import test from "node:test"
import assert from "node:assert/strict"

import {
  describeStage,
  friendlyFailureLabel,
  isTerminalStage,
  shouldFireReadyTransition,
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

test("shouldFireReadyTransition fires on a real non-ready → ready edge", () => {
  assert.equal(shouldFireReadyTransition("uploaded",   "ready"), true)
  assert.equal(shouldFireReadyTransition("validating", "ready"), true)
  assert.equal(shouldFireReadyTransition("extracting", "ready"), true)
  assert.equal(shouldFireReadyTransition("chunking",   "ready"), true)
  assert.equal(shouldFireReadyTransition("embedding",  "ready"), true)
  assert.equal(shouldFireReadyTransition("indexing",   "ready"), true)
})

test("shouldFireReadyTransition stays quiet on initial mount onto an already-ready file", () => {
  // First poll lands directly on `ready` — `previous` is null because
  // the consumer just mounted. Toasting here would be a lie.
  assert.equal(shouldFireReadyTransition(null,      "ready"), false)
  assert.equal(shouldFireReadyTransition(undefined, "ready"), false)
})

test("shouldFireReadyTransition stays quiet on ready→ready re-renders", () => {
  // The hook re-emits state on every poll; the badge must not re-fire
  // the toast every time the same `ready` value is reported.
  assert.equal(shouldFireReadyTransition("ready", "ready"), false)
})

test("shouldFireReadyTransition stays quiet on every non-ready current stage", () => {
  const nonReady = ["uploaded", "validating", "extracting", "chunking", "embedding", "indexing", "failed"] as const
  for (const cur of nonReady) {
    assert.equal(
      shouldFireReadyTransition("extracting", cur),
      false,
      `should not fire when current stage is '${cur}'`,
    )
  }
})

test("shouldFireReadyTransition tolerates null/undefined current without firing", () => {
  assert.equal(shouldFireReadyTransition("extracting", null),      false)
  assert.equal(shouldFireReadyTransition("extracting", undefined), false)
})

test("describeStage falls back to the stage name + neutral tone for unknown stages", () => {
  // The default branch in the switch — future stages added by the
  // backend should NOT crash old clients but show the raw stage name
  // with a neutral tone. Cast to bypass the compile-time exhaustive
  // check on purpose.
  const out = describeStage("future_unknown_stage" as any)
  assert.deepEqual(out, { label: "future_unknown_stage", tone: "neutral" })
})

test("describeStage('failed') label respects the input prefix even with mixed case + suffix noise", () => {
  // Robust against backend reasons that carry extra context after a colon.
  assert.equal(
    describeStage("failed", "MAGIC_BYTE_MISMATCH: detected=image/jpeg, expected=image/png").label,
    "Tipo de archivo no permitido",
  )
})
