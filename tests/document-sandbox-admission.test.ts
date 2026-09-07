import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentSandboxClientError } from "../lib/document-sandbox-client"
import {
  admitDocumentSandboxTurn,
  isDocumentSandboxRuntimeReady,
  isDocumentSandboxUnavailableError,
  resolveDocumentSandboxAdmission,
  routeDocumentSandboxTurn,
} from "../lib/document-sandbox-routing"

const file = () => new File([new Uint8Array([80, 75, 3, 4, 1])], "Modelo Informe.docx", {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
})
const document = () => ({ id: "uploaded-1", name: "Modelo Informe.docx", file: file() })
const ready = { enabled: true, ready: true }
const disabled = { enabled: false, ready: false }
const notReady = { enabled: true, ready: false }

test("no document attachment stays outside sandbox admission", () => {
  assert.equal(routeDocumentSandboxTurn("cambia el título del documento", []), null)
  assert.equal(routeDocumentSandboxTurn("cambia el título", [{ name: "imagen.png" }]), null)
  assert.equal(resolveDocumentSandboxAdmission({ route: null, capabilities: ready }), "none")
  assert.equal(resolveDocumentSandboxAdmission({ route: null, capabilities: disabled }), "none")
})

test("sandbox ready + explicit edit uses the verified sandbox path", () => {
  assert.equal(routeDocumentSandboxTurn("cambia el título a 2027", [document()]), "edit")
  assert.equal(isDocumentSandboxRuntimeReady(ready), true)
  assert.equal(resolveDocumentSandboxAdmission({ route: "edit", capabilities: ready }), "sandbox")
})

test("sandbox disabled, not configured or not ready falls back to the legacy editor", () => {
  for (const capabilities of [disabled, notReady, null, undefined]) {
    assert.equal(isDocumentSandboxRuntimeReady(capabilities), false)
    assert.equal(resolveDocumentSandboxAdmission({ route: "edit", capabilities }), "legacy")
    assert.equal(resolveDocumentSandboxAdmission({ route: "clarify", capabilities }), "legacy")
  }
})

test("E_NOT_READY and similar pre-admission outages fall back to the legacy editor", () => {
  for (const code of ["E_NOT_READY", "E_NOT_FOUND", "E_CONNECTION"] as const) {
    assert.equal(isDocumentSandboxUnavailableError(new DocumentSandboxClientError(code)), true)
    assert.equal(resolveDocumentSandboxAdmission({ route: "edit", error: { code } }), "legacy")
  }
})

test("a rejected admission never falls back to a second editor", () => {
  const rejected = new DocumentSandboxClientError("E_NOT_READY", 503, true)
  assert.equal(isDocumentSandboxUnavailableError(rejected), false)
  assert.equal(resolveDocumentSandboxAdmission({
    route: "edit",
    error: { code: "E_NOT_READY", admissionRejected: true },
  }), "blocked")
})

test("model, permission and ambiguous-edit errors stay blocked when the sandbox is ready", () => {
  for (const code of ["E_MODEL", "E_PLAN_GATE", "E_FORMAT", "E_PARAMS", "E_AUTH", "E_EDIT_AMBIGUOUS"] as const) {
    assert.equal(isDocumentSandboxUnavailableError(new DocumentSandboxClientError(code)), false)
    assert.equal(resolveDocumentSandboxAdmission({ route: "edit", error: { code } }), "blocked")
  }
  assert.equal(resolveDocumentSandboxAdmission({ route: "clarify", capabilities: ready }), "clarify")
})

test("admitDocumentSandboxTurn probes readiness before choosing a path", async () => {
  const calls: string[] = []
  const capabilities = async (model: string) => {
    calls.push(model)
    return ready
  }
  assert.equal(await admitDocumentSandboxTurn("cambia el título a 2027", [document()], "chosen", { capabilities }), "sandbox")
  assert.equal(await admitDocumentSandboxTurn("cambia el título a 2027", [document()], "chosen", {
    capabilities: async () => disabled,
  }), "legacy")
  assert.equal(await admitDocumentSandboxTurn("cambia el título a 2027", [document()], "chosen", {
    capabilities: async () => { throw new DocumentSandboxClientError("E_NOT_READY") },
  }), "legacy")
  assert.equal(await admitDocumentSandboxTurn("cambia el título del documento", [], "chosen", { capabilities }), "legacy")
  assert.equal(await admitDocumentSandboxTurn("hola", [document()], "chosen", { capabilities }), "legacy")
  assert.equal(await admitDocumentSandboxTurn("¿Puedes editar este Word?", [document()], "chosen", { capabilities }), "clarify")
  assert.equal(calls.length, 2)
  await assert.rejects(
    admitDocumentSandboxTurn("cambia el título a 2027", [document()], "chosen", {
      capabilities: async () => { throw new DocumentSandboxClientError("E_AUTH") },
    }),
    (error: unknown) => error instanceof DocumentSandboxClientError && error.code === "E_AUTH",
  )
})

test("Stop during the readiness probe does not start the legacy editor", async () => {
  const controller = new AbortController()
  controller.abort(new DOMException("Stopped", "AbortError"))
  await assert.rejects(
    admitDocumentSandboxTurn("cambia el título a 2027", [document()], "chosen", {
      signal: controller.signal,
      capabilities: async () => ready,
    }),
    { name: "AbortError" },
  )
})
