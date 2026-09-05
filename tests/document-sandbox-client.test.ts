import assert from "node:assert/strict"
import { test } from "node:test"
import { createDocumentSandboxClient, documentJobState, isExplicitDocumentEdit, parseDocumentJobPointer,
  parseDocumentSnapshot, serializeDocumentJobState, DocumentSandboxClientError } from "../lib/document-sandbox-client"
import { routeDocumentSandboxTurn } from "../lib/document-sandbox-routing"

// HTTP protocol fixtures test the client only. These are not editor, independent
// validation or paid-provider E2E evidence; those gates run in the backend suite.
// Simulated HTTP disqualifies these auxiliary probes as SPEC §10.2 acceptance.
const base = "https://test.example/api"
const hash = "a".repeat(64)
const pointer = { version: 1 as const, idempotencyKey: "doc-test-admission" }
const file = () => new File([new Uint8Array([80, 75, 3, 4, 1])], "Modelo Informe.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })
const source = () => ({ id: "uploaded-1", name: "Modelo Informe.docx", file: file() })
const snapshot = (status = "queued", extra = {}) => ({ id: "job-1", status, eventSeq: 1, admissionReady: true, ...(status === "done" ? { outcome: "edited" } : {}),
  artifacts: [], errorCode: null, ...extra })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
const capabilities = { enabled: true, ready: true, supported: true, modelTier: "mechanical", modes: ["preserve"],
  formats: ["docx", "xlsx", "pptx", "pdf", "txt", "md", "csv", "json", "html"], limits: { maxFiles: 10, maxFileBytes: 50 * 1024 * 1024 } }
const artifacts = [
  { id: "output-1", kind: "output", name: "Modelo Informe.docx", mime: file().type, size: 5, sha256: hash },
  { id: "validation-1", kind: "validation_report", name: "validation_report.json", mime: "application/json", size: 12, sha256: hash },
]
const code = (expected: string) => (error: unknown) => error instanceof DocumentSandboxClientError && error.code === expected

for (const instruction of ["cambia en el título de 2026 al 2027 en mi mismo Word", "por favor corrige la fecha", "quiero que reemplaces el título", "edita mi documento", "No cambies nada; solo confirma que lo lees", "No modifiques nada", "une los PDF", "replace the title",
  "¿Puedes cambiar el título a 2027?", "en el título cambia 2026 a 2027", "mejorar la redacción de mi Word", "corregir las faltas", "por favor cambia el título", "necesito corregir la tabla", "en mi mismo Word cambia el título a 2027"]) {
  test(`explicit edit routing: ${instruction}`, () => assert.equal(isExplicitDocumentEdit(instruction, [source()]), true))
}
for (const instruction of ["hola", "explica el cambio del documento", "¿Puedes editar este Word?", "describe cómo reemplazar un título", "resume este documento", "analiza el informe", "no edites nada de mi documento", 'El documento dice "reemplaza el título"', "qué cambios harías", "dime si se puede editar"]) {
  test(`does not hijack document discussion: ${instruction}`, () => assert.equal(isExplicitDocumentEdit(instruction, [source()]), false))
}
test("edits without a document or image-only attachments stay outside this adapter", () => {
  assert.equal(isExplicitDocumentEdit("cambia el título", []), false)
  assert.equal(isExplicitDocumentEdit("edita la imagen", [{ name: "imagen.png" }]), false)
})
test("routing refuses ambiguous legacy edits instead of falling back, while plain questions retain retrieval", () => {
  for (const prompt of ["¿Puedes editar este Word?", "resume este documento", "describe el documento y cambia el título"]) {
    assert.equal(routeDocumentSandboxTurn(prompt, [source()]), "clarify", prompt)
  }
  for (const prompt of ["hola", "explica el cambio del documento", "cuál es el título", "analiza el informe",
    "describe cómo reemplazar un título", "no edites nada de mi documento", "dime si se puede editar",
    "resume este documento sin modificar el original"]) {
    assert.equal(routeDocumentSandboxTurn(prompt, [source()]), null, prompt)
  }
  assert.equal(routeDocumentSandboxTurn("cambia el título del documento", []), null)
  assert.equal(routeDocumentSandboxTurn("cambia el título", [{ name: "imagen.png" }]), null)
})
test("durable pointer is narrow and does not reinterpret legacy tasks", () => {
  assert.deepEqual(parseDocumentJobPointer(JSON.stringify({ source: "doc-sandbox", docSandbox: pointer })), pointer)
  for (const value of [{ taskId: "legacy" }, "not-json", { docSandbox: { version: 1, idempotencyKey: "../escape" } }]) {
    assert.equal(parseDocumentJobPointer(value), null)
  }
})
test("progress and failed jobs never expose candidate outputs or validation badges", () => {
  for (const status of ["queued", "inspecting", "planning", "editing", "validating", "failed", "cancelled"]) {
    const state = documentJobState(parseDocumentSnapshot(snapshot(status, { artifacts })))
    assert.deepEqual(state.artifacts, [])
    assert.equal(state.done, ["failed", "cancelled"].includes(status))
  }
})
test("done without an independent report fails closed", () => {
  const state = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts: [artifacts[0]] })))
  assert.equal(state.artifacts.length, 0)
  assert.match(state.error || "", /validar/)
})
test("incomplete or contradictory completion cannot claim a validated edit", () => {
  for (const extra of [{ outcome: undefined }, { outcome: "unknown" }, { admissionReady: false }, { admissionReady: undefined }, { errorCode: "E_VALIDATION" }]) {
    const state = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, ...extra })))
    assert.equal(state.artifacts.length, 0)
    assert.match(state.error || "", /validar/)
    assert.doesNotMatch(state.finalText || "", /pasó la validación independiente/)
  }
})
test("validated delivery preserves filename and uses a stable owner-mediated route, not a persisted ticket", () => {
  const state = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, outcome: "edited" })))
  assert.equal(state.artifacts[0].filename, "Modelo Informe.docx")
  assert.equal(state.artifacts[0].validation?.passed, true)
  assert.equal(state.artifacts[0].downloadUrl, "/api/docs/jobs/job-1/artifacts/output-1?download=1")
  assert.doesNotMatch(serializeDocumentJobState(state), /signature=|s3:|r2\.|storageKey|provider|runtimeModel/)
})
test("not_possible and no-op never claim the requested edit was made", () => {
  const rejected = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, outcome: "not_possible" })))
  assert.match(rejected.finalText, /original intacto/)
  assert.match(rejected.finalText, /sin presentar esto como una edición/)
  const unchanged = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, outcome: "unchanged" })))
  assert.match(unchanged.finalText, /sin modificar/)
})
test("reports are downloadable but only the validated document carries a validation badge", () => {
  const state = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts })))
  assert.equal(state.artifacts.length, 2)
  assert.equal(state.artifacts[1].filename, "validation_report.json")
  assert.equal(state.artifacts[1].validation, undefined)
})
test("cost is displayed only when supplied; uncertain cost is never zero", () => {
  const hidden = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts })))
  assert.doesNotMatch(hidden.finalText, /Costo|US\$/)
  const pending = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, costUsd: null, costStatus: "pending" })))
  assert.match(pending.finalText, /Costo pendiente/)
  assert.doesNotMatch(pending.finalText, /US\$0/)
  const estimated = documentJobState(parseDocumentSnapshot(snapshot("done", { artifacts, costUsd: "0.01400000", costStatus: "estimated" })))
  assert.match(estimated.finalText, /Costo estimado: US\$0.01400000/)
})
test("malformed snapshots, traversal filenames and missing hashes cannot produce a validated artifact", () => {
  for (const value of [{}, snapshot("unknown"), snapshot("done", { artifacts: [{ ...artifacts[0], sha256: "" }] }),
    snapshot("done", { artifacts: [{ ...artifacts[0], name: "../secret.docx" }] })]) {
    assert.throws(() => parseDocumentSnapshot(value), DocumentSandboxClientError)
  }
})
test("preflight preserves exact model, permission, name and original bytes in multipart", async () => {
  const urls: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, readPermission: () => "workspace", request: async (url) => {
    urls.push(String(url)); return response(capabilities)
  } })
  const original = source()
  const form = await client.prepare("cambia el año", [original], "chosen-exact")
  assert.equal(urls[0], `${base}/docs/jobs/capabilities?model=chosen-exact`)
  assert.equal(form.get("requestedModel"), "chosen-exact")
  assert.equal(form.get("modelTier"), "mechanical")
  assert.equal(form.get("permission"), "workspace")
  assert.equal(form.get("mode"), "preserve")
  const sent = form.get("files[]") as File
  assert.equal(sent.name, original.name)
  assert.deepEqual(await sent.arrayBuffer(), await original.file.arrayBuffer())
  assert.equal(urls.length, 1)
})
test("read/protected permissions block before network or paid admission", async () => {
  for (const permission of ["read", "protected"] as const) {
    let calls = 0
    const client = createDocumentSandboxClient({ apiBase: base, readPermission: () => permission,
      request: async () => { calls++; return response(capabilities) } })
    await assert.rejects(client.prepare("edita", [source()], "chosen"), code("E_PLAN_GATE"))
    assert.equal(calls, 0)
  }
})
test("incompatible selection and unavailable runtime never create a job or fallback request", async () => {
  for (const caps of [{ ...capabilities, supported: false }, { ...capabilities, ready: false }]) {
    const calls: string[] = []
    const client = createDocumentSandboxClient({ apiBase: base, request: async (url) => { calls.push(String(url)); return response(caps) } })
    await assert.rejects(client.prepare("edita", [source()], "chosen"), code(caps.ready ? "E_MODEL" : "E_NOT_READY"))
    assert.equal(calls.length, 1)
    assert.ok(calls.every((url) => url.includes("/capabilities?model=chosen")))
  }
})
test("restored attachment without original File is rejected; extracted text and arbitrary URLs are never used", async () => {
  const calls: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (url) => { calls.push(String(url)); return response(capabilities) } })
  await assert.rejects(client.prepare("edita", [{ id: "uploaded-1", name: "informe.docx", extractedText: "not original", url: "https://evil.example/file" }], "chosen"), code("E_PARAMS"))
  assert.equal(calls.length, 1)
})
test("mixed batches and unsupported formats fail before admission", async () => {
  const client = createDocumentSandboxClient({ apiBase: base, request: async () => response(capabilities) })
  await assert.rejects(client.prepare("edita", [source(), source()], "chosen"), code("E_FORMAT"))
  await assert.rejects(client.prepare("edita", [{ name: "macros.xlsm", file: new File(["data"], "macros.xlsm") }], "chosen"), code("E_FORMAT"))
})
test("lost POST response recovers by the same durable idempotency key without another POST", async () => {
  const calls: Array<{ url: string; method: string; key: string | null }> = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET", key: new Headers(init?.headers).get("Idempotency-Key") })
    if (init?.method === "POST") throw new TypeError("network disconnected")
    return response(snapshot())
  } })
  const result = await client.submit(new FormData(), pointer)
  assert.equal(result.id, "job-1")
  assert.equal(calls.filter((item) => item.method === "POST").length, 1)
  assert.equal(calls[0].key, pointer.idempotencyKey)
  assert.equal(calls[1].url, `${base}/docs/jobs/by-key/${pointer.idempotencyKey}`)
})
test("HTTP 500 after a possible commit is recovered by key, never treated as a definitive rejection", async () => {
  const methods: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (_url, init) => {
    methods.push(init?.method || "GET")
    return init?.method === "POST" ? response({ code: "E_INTERNAL" }, 500) : response(snapshot())
  } })
  assert.equal((await client.submit(new FormData(), pointer)).id, "job-1")
  assert.deepEqual(methods, ["POST", "GET"])
})
test("definitive upload/model/permission HTTP rejections retain status and never resubmit", async () => {
  for (const [status, errorCode] of [[400, "E_MODEL"], [403, "E_PLAN_GATE"], [413, "E_PARAMS"], [415, "E_FORMAT"], [503, "E_NOT_READY"]] as const) {
    let calls = 0
    const client = createDocumentSandboxClient({ apiBase: base, request: async () => { calls++; return response({ code: errorCode }, status) } })
    await assert.rejects(client.submit(new FormData(), pointer), (error: unknown) => {
      assert.ok(error instanceof DocumentSandboxClientError)
      assert.equal(error.code, errorCode); assert.equal(error.httpStatus, status); assert.equal(error.admissionRejected, true)
      return true
    })
    assert.equal(calls, 1)
  }
})
test("only confirmed 404 recovery can report missing admission; outages remain uncertain", async () => {
  for (const status of [404, 503]) {
    let now = 0; let calls = 0
    const client = createDocumentSandboxClient({ apiBase: base, recoveryMs: 2000, now: () => now, sleep: async (ms) => { now += ms },
      request: async () => { calls++; return response({ code: status === 404 ? "E_NOT_FOUND" : "E_NOT_READY" }, status) } })
    await assert.rejects(client.recover(pointer), code(status === 404 ? "E_ADMISSION_NOT_FOUND" : "E_ADMISSION_UNKNOWN"))
    assert.equal(calls, 3)
  }
})
test("404/incomplete admission is bounded and never re-posted", async () => {
  let now = 0; let calls = 0
  const client = createDocumentSandboxClient({ apiBase: base, recoveryMs: 2000, now: () => now, sleep: async (ms) => { now += ms },
    request: async (_url, init) => { assert.notEqual(init?.method, "POST"); calls++; return response(snapshot("queued", { admissionReady: false })) } })
  await assert.rejects(client.recover(pointer), code("E_ADMISSION_UNKNOWN"))
  assert.equal(calls, 3)
})
test("closed SSE rehydrates terminal snapshot without needing a terminal event", async () => {
  let reads = 0; const methods: string[] = []; const resume: string[] = []
  const seen: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, sleep: async () => {}, request: async (url, init) => {
    methods.push(init?.method || "GET")
    if (String(url).endsWith("/events")) {
      resume.push(new Headers(init?.headers).get("Last-Event-ID") || "")
      return new Response(": heartbeat\n\n", { headers: { "Content-Type": "text/event-stream" } })
    }
    reads++
    return response(reads === 1 ? snapshot("editing", { eventSeq: 4 }) : snapshot("done", { eventSeq: 5, artifacts }))
  } })
  const result = await client.observe("job-1", (value) => seen.push(value.status))
  assert.equal(result.status, "done")
  assert.deepEqual(seen, ["editing", "done"])
  assert.deepEqual(resume, ["4"])
  assert.ok(methods.every((method) => method === "GET"))
})
test("Stop calls persistent cancellation and waits for authoritative terminal state", async () => {
  const calls: Array<{ url: string; method: string }> = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" })
    return response(String(url).includes("/by-key/") ? snapshot("editing") : snapshot("cancelled"))
  } })
  assert.equal((await client.cancel(pointer)).status, "cancelled")
  assert.equal(calls[1].url, `${base}/docs/jobs/job-1/cancel`)
  assert.equal(calls[1].method, "POST")
  assert.equal(calls[2].method, "GET")
})
test("Stop cancels a durable admission even before input upload becomes ready", async () => {
  const calls: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (url, init) => {
    calls.push(`${init?.method || "GET"} ${String(url)}`)
    return response(String(url).includes("/by-key/") ? snapshot("queued", { admissionReady: false }) : snapshot("cancelled"))
  } })
  assert.equal((await client.cancel(pointer)).status, "cancelled")
  assert.equal(calls.length, 3)
  assert.equal(calls[1], `POST ${base}/docs/jobs/job-1/cancel`)
})
test("detaching an SSE observer never calls the cancellation endpoint", async () => {
  const controller = new AbortController(); const urls: string[] = []
  const client = createDocumentSandboxClient({ apiBase: base, request: async (url) => {
    urls.push(String(url))
    controller.abort(new DOMException("Detached", "AbortError"))
    throw controller.signal.reason
  } })
  await assert.rejects(client.observe("job-1", () => {}, controller.signal), { name: "AbortError" })
  assert.ok(urls.every((url) => !url.includes("cancel")))
})
test("forbidden errors do not leak server payload or retry as another owner", async () => {
  let calls = 0
  const client = createDocumentSandboxClient({ apiBase: base, request: async () => { calls++; return response({ message: "private internal detail", code: "anything" }, 403) } })
  await assert.rejects(client.observe("job-1", () => {}), (error: unknown) => {
    assert.ok(error instanceof DocumentSandboxClientError)
    assert.equal(error.code, "E_FORBIDDEN")
    assert.doesNotMatch(error.message, /private internal detail/)
    return true
  })
  assert.equal(calls, 1)
})
