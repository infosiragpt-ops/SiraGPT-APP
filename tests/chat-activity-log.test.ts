import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  activityDurationMs,
  activitySignature,
  activityToPlaceholderSteps,
  appendActivity,
  finalizeActivity,
  hasPairedActivity,
  hydrateActivityTrace,
  safeThumbs,
} from "../lib/chat/activity-log"

describe("live activity log (Claude-style thinking timeline)", () => {
  it("keeps one active step and settles the earlier ones", () => {
    let log = appendActivity([], { label: "Leyendo el archivo adjunto", tool: "read_file" }, 1000)
    log = appendActivity(log, { label: "Analizando la imagen", tool: "vision" }, 2000)
    log = appendActivity(log, { label: "Pensando", tool: "model" }, 3000)
    assert.deepEqual(log.map((s) => [s.label, s.status]), [
      ["Leyendo el archivo adjunto", "done"],
      ["Analizando la imagen", "done"],
      ["Pensando", "active"],
    ])
    assert.equal(log[0].tool, "read_file")
  })

  it("ignores empty labels and de-duplicates a re-announced phase", () => {
    let log = appendActivity([], { label: "Buscando en la web", tool: "web_search" }, 1)
    log = appendActivity(log, { label: "  " }, 2)
    log = appendActivity(log, { text: "Buscando en la web", tool: "web_search" }, 3)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "active")
  })

  it("finalizes once text arrives and reports the thinking duration", () => {
    let log = appendActivity([], { label: "Buscando en la web" }, 1000)
    log = appendActivity(log, { label: "Pensando" }, 4000)
    const settled = finalizeActivity(log)
    assert.ok(settled.every((s) => s.status === "done"))
    assert.equal(finalizeActivity(settled), settled, "no-op when nothing is active")
    assert.equal(activityDurationMs(settled, 6500), 5500)
    assert.equal(activityDurationMs(settled, null), null)
    assert.equal(activityDurationMs([], 6500), null)
  })

  it("maps to the thinking placeholder's step contract", () => {
    const log = appendActivity(appendActivity([], { label: "Leyendo 3 fuentes", tool: "web_fetch" }, 1), { label: "Pensando", tool: "model" }, 2)
    const steps = activityToPlaceholderSteps(log)
    assert.deepEqual(steps.map((s) => [s.label, s.status, s.name]), [
      ["Leyendo 3 fuentes", "done", "web_fetch"],
      ["Pensando", "executing", "model"],
    ])
  })
})

const THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

describe("stage v2: one row per tool call (edición milimétrica)", () => {
  it("a tool_result settles its own call row: status, result detail and thumbnail", () => {
    let log = appendActivity([], { type: "stage", step: "tool_call", tool: "office_edit", callId: "c1", kind: "edit", label: "Cambiando el año", description: "Cambiando el año", detail: "uploads/t.docx → outputs/\n{\"op\":\"replace_text\"}" }, 1000)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "active")
    assert.equal(log[0].kind, "edit")
    log = appendActivity(log, { type: "stage", step: "tool_result", tool: "office_edit", callId: "c1", ok: true, label: "Cambiando el año", detail: "{\"ok\":true}" }, 1800)
    assert.equal(log.length, 1, "the result updates the call row, never a new row")
    assert.equal(log[0].status, "done")
    assert.equal(log[0].result, "{\"ok\":true}")
    assert.match(log[0].detail || "", /replace_text/)
    assert.equal(log[0].endedAt, 1800)

    log = appendActivity(log, { type: "stage", step: "tool_call", tool: "verify_visual", callId: "c2", kind: "check", label: "Comparando antes y después" }, 2000)
    log = appendActivity(log, { type: "stage", step: "tool_result", tool: "verify_visual", callId: "c2", ok: false, label: "Comparando antes y después", preview: "ERROR: verificación fallida", thumbs: [THUMB, "javascript:alert(1)"] }, 7000)
    assert.equal(log.length, 2)
    assert.equal(log[1].status, "error", "ok:false → error")
    assert.deepEqual(log[1].thumbs, [THUMB], "only image data URLs survive")
    assert.equal(log[1].result, "ERROR: verificación fallida")
  })

  it("paired rows never merge by label; parallel calls stay active until their own result", () => {
    let log = appendActivity([], { type: "stage", step: "tool_call", callId: "a", label: "Leyendo el documento" }, 1)
    log = appendActivity(log, { type: "stage", step: "tool_call", callId: "b", label: "Leyendo el documento" }, 2)
    assert.equal(log.length, 2, "same phrase, two calls → two rows")
    assert.deepEqual(log.map((s) => s.status), ["active", "active"])
    log = appendActivity(log, { type: "stage", step: "tool_result", callId: "b", ok: true, label: "Leyendo el documento" }, 3)
    assert.deepEqual(log.map((s) => s.status), ["active", "done"])
    // An un-paired heartbeat after them still settles only un-paired rows.
    log = appendActivity(log, { type: "stage", step: "iteration_start", label: "Pensando" }, 4)
    assert.deepEqual(log.map((s) => s.status), ["active", "done", "active"])
    assert.ok(hasPairedActivity(log))
    assert.ok(!hasPairedActivity(appendActivity([], { label: "Buscando en la web" }, 1)))
  })

  it("a reloaded turn replays the persisted trace (agent_metadata.activityTrace) and settles it", () => {
    const meta = {
      kind: "agent_runner_trace",
      version: 2,
      durationMs: 24000,
      activityTrace: [
        { at: 0, step: "stage", tool: "agent_runner", label: "Agente trabajando" },
        { at: 900, step: "tool_call", tool: "inspect_document", callId: "c1", kind: "document", status: "running", label: "Buscando «2024» en la tesis", detail: "uploads/t.docx\nquery: 2024" },
        { at: 1500, step: "tool_result", tool: "inspect_document", callId: "c1", kind: "document", status: "done", ok: true, label: "Buscando «2024» en la tesis", detail: "{\"paragraphs\":[]}" },
        { at: 2000, step: "tool_call", tool: "verify_visual", callId: "c2", kind: "check", status: "running", label: "Comparando antes y después" },
        { at: 8000, step: "tool_result", tool: "verify_visual", callId: "c2", kind: "check", status: "done", ok: true, label: "Comparando antes y después", thumbs: ["/api/agent/artifact/0123456789abcdef?name=timeline-c2-1.jpg"] },
      ],
    }
    const log = hydrateActivityTrace(meta)
    assert.deepEqual(log.map((s) => [s.label, s.status]), [
      ["Agente trabajando", "done"],
      ["Buscando «2024» en la tesis", "done"],
      ["Comparando antes y después", "done"],
    ])
    assert.deepEqual(log[2].thumbs, ["/api/agent/artifact/0123456789abcdef?name=timeline-c2-1.jpg"])
    assert.equal(hydrateActivityTrace(JSON.stringify(meta)).length, 3, "the JSON column may arrive as a string")
    assert.deepEqual(hydrateActivityTrace(null), [])
    assert.deepEqual(hydrateActivityTrace({ steps: [] }), [], "a harness run (agent steps) is not a runner trace")
    assert.deepEqual(hydrateActivityTrace("{broken"), [])
  })

  it("thumbnails: image data URLs and our own artifact URLs only; the memo signature sees every change", () => {
    assert.deepEqual(safeThumbs([THUMB, "/api/agent/artifact/abcdef0123456789?name=x.jpg", "https://evil.example/a.png", "data:text/html;base64,PGI+", 7]), [THUMB, "/api/agent/artifact/abcdef0123456789?name=x.jpg"])
    let log = appendActivity([], { type: "stage", step: "tool_call", callId: "c1", label: "Renderizando" }, 1)
    const before = activitySignature(log)
    log = appendActivity(log, { type: "stage", step: "tool_result", callId: "c1", ok: true, label: "Renderizando", thumbs: [THUMB] }, 2)
    assert.notEqual(activitySignature(log), before, "same length, new status + thumbnail → re-render")
    assert.equal(activitySignature([]), "")
  })
})

describe("stage v3: live pipeline progress (stageId begin → progress → result)", () => {
  const begin = (stageId: string, label: string, extra: Record<string, unknown> = {}) =>
    ({ type: "stage", step: "tool_call", status: "running", stageId, phase: stageId.split(":")[1], label, ...extra })

  it("one stageId is one row: progress updates it in place, the result settles it with the server duration", () => {
    let log = appendActivity([], begin("pipe:attachments:1", "Leyendo «contrato.pdf»", { tool: "read_file" }), 1000)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "active")
    assert.equal(log[0].phase, "attachments")
    log = appendActivity(log, { type: "stage", step: "tool_progress", status: "running", stageId: "pipe:attachments:1", label: "Extrayendo el texto de «contrato.pdf»", detail: "38 páginas", meta: { pages: 38, bogus: "x" } }, 1500)
    assert.equal(log.length, 1, "progress never adds a row")
    assert.equal(log[0].label, "Extrayendo el texto de «contrato.pdf»")
    assert.equal(log[0].detail, "38 páginas")
    assert.deepEqual(log[0].meta, { pages: 38 }, "meta keeps finite numbers only")
    assert.equal(log[0].at, 1000, "the row keeps its start")
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:attachments:1", label: "Archivos listos", detail: "38 páginas · 12.340 palabras", elapsedMs: 1840 }, 2900)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "done")
    assert.equal(log[0].label, "Archivos listos")
    assert.equal(log[0].detail, "38 páginas · 12.340 palabras")
    assert.equal(log[0].durationMs, 1840, "server elapsedMs wins")
    assert.equal(log[0].endedAt, 2900)
    assert.equal(log[0].at, 1000)
    assert.ok(!hasPairedActivity(log), "stage rows never switch the bubble to the rail")
  })

  it("an in-place detail update (same label) changes the memo signature", () => {
    let log = appendActivity([], begin("pipe:rag:2", "Buscando los pasajes relevantes"), 1)
    const before = activitySignature(log)
    log = appendActivity(log, { type: "stage", step: "tool_progress", stageId: "pipe:rag:2", label: "Buscando los pasajes relevantes", detail: "142 fragmentos" }, 2)
    assert.equal(log.length, 1)
    assert.notEqual(activitySignature(log), before, "same label, new detail → re-render")
    const same = appendActivity(log, { type: "stage", step: "tool_progress", stageId: "pipe:rag:2", label: "Buscando los pasajes relevantes", detail: "142 fragmentos" }, 3)
    assert.equal(same, log, "an identical progress frame is a no-op")
  })

  it("a new stage does not settle an open stage row, but it settles a legacy row", () => {
    let log = appendActivity([], { label: "Leyendo el archivo adjunto", tool: "read_file" }, 1)
    log = appendActivity(log, begin("pipe:memory:1", "Consultando tu memoria"), 2)
    log = appendActivity(log, begin("pipe:web:2", "Buscando en la web · “cobre 2026”"), 3)
    assert.deepEqual(log.map((s) => [s.label, s.status]), [
      ["Leyendo el archivo adjunto", "done"],
      ["Consultando tu memoria", "active"],
      ["Buscando en la web · “cobre 2026”", "active"],
    ])
    assert.equal(log[0].endedAt, 2, "a settled legacy row gets an end time")
    // A legacy frame (no stageId) never closes stage rows either.
    log = appendActivity(log, { label: "Pensando", tool: "model" }, 4)
    assert.deepEqual(log.map((s) => s.status), ["done", "active", "active", "active"])
  })

  it("a new begin of the same phase supersedes an open row whose result was lost (no zombie rows)", () => {
    // Lost done frame: the model phase restarts under a new stageId.
    let log = appendActivity([], begin("pipe:model:3", "Conectando con DeepSeek V4 Pro"), 1000)
    log = appendActivity(log, begin("pipe:memory:4", "Consultando tu memoria"), 1100)
    log = appendActivity(log, begin("pipe:model:5", "Conectando con DeepSeek V4 Flash"), 4000)
    assert.deepEqual(log.map((s) => [s.stageId, s.status]), [
      ["pipe:model:3", "done"],
      ["pipe:memory:4", "active"],
      ["pipe:model:5", "active"],
    ])
    assert.equal(log[0].endedAt, 4000, "the superseded row ends where its successor began")
    // Retried request whose counter restarted: the new attempt's first phase
    // closes the old attempt's open row of that phase instead of stranding it.
    let retry = appendActivity([], begin("pipe:attachments:1", "Leyendo «contrato.pdf»"), 10)
    retry = appendActivity(retry, begin("pipe:understanding:2", "Analizando tu mensaje · 38 palabras"), 20)
    retry = appendActivity(retry, begin("pipe:understanding:9", "Analizando tu mensaje · 38 palabras"), 900)
    assert.deepEqual(retry.map((s) => [s.stageId, s.status]), [
      ["pipe:attachments:1", "active"],
      ["pipe:understanding:2", "done"],
      ["pipe:understanding:9", "active"],
    ])
    // A late result for the superseded row still lands on it (server duration wins).
    retry = appendActivity(retry, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:understanding:2", label: "Mensaje analizado", elapsedMs: 70 }, 950)
    assert.equal(retry.length, 3)
    assert.equal(retry[1].durationMs, 70)
    assert.equal(retry[2].status, "active", "a late result never closes the newer row")
  })

  it("a late result after finalizeActivity updates label and duration without adding a row", () => {
    let log = appendActivity([], begin("pipe:post:9", "Comprobando las fuentes"), 1000)
    log = finalizeActivity(log, 1400)
    assert.equal(log[0].status, "done")
    assert.equal(log[0].endedAt, 1400, "finalize stamps the end")
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:post:9", label: "Fuentes comprobadas", elapsedMs: 650 }, 1700)
    assert.equal(log.length, 1)
    assert.equal(log[0].label, "Fuentes comprobadas")
    assert.equal(log[0].durationMs, 650)
    // A late progress frame for a settled row changes nothing.
    const after = appendActivity(log, { type: "stage", step: "tool_progress", stageId: "pipe:post:9", label: "Otra cosa" }, 1800)
    assert.equal(after, log)
  })

  it("a failed result marks the row as an error", () => {
    let log = appendActivity([], begin("pipe:model:3", "Conectando con DeepSeek V4 Flash"), 1)
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "error", ok: false, stageId: "pipe:model:3", label: "DeepSeek V4 Flash no disponible (sin saldo)", elapsedMs: 300 }, 2)
    assert.equal(log[0].status, "error")
    assert.equal(log[0].ok, false)
  })

  it("progress or a result for an unknown stageId (reconnect) lands as its own row", () => {
    let log = appendActivity([], { type: "stage", step: "tool_progress", stageId: "pipe:rag:4", label: "Indexando «anexo.xlsx»" }, 10)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "active")
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:web:5", label: "Fuentes encontradas", elapsedMs: 900 }, 2000)
    assert.equal(log.length, 2)
    assert.equal(log[1].status, "done")
    assert.equal(log[1].at, 1100, "the start is back-dated by elapsedMs")
    assert.equal(log[1].durationMs, 900)
    assert.equal(log[0].status, "active", "an open stage row stays open")
  })

  it("hydrates a persisted plain-turn trace by pairing begin / done", () => {
    const meta = {
      durationMs: 5200,
      activityTrace: [
        { at: 0, step: "tool_call", status: "running", stageId: "pipe:attachments:1", phase: "attachments", tool: "read_file", label: "Leyendo «contrato.pdf»" },
        { at: 1840, step: "tool_result", status: "done", ok: true, stageId: "pipe:attachments:1", phase: "attachments", tool: "read_file", label: "Archivos listos", detail: "1 documento · 12.340 palabras", elapsedMs: 1840 },
        { at: 1900, step: "tool_call", status: "running", stageId: "pipe:model:2", phase: "model", tool: "model", label: "Conectando con DeepSeek V4 Pro" },
      ],
    }
    const log = hydrateActivityTrace(meta)
    assert.deepEqual(log.map((s) => [s.label, s.status]), [
      ["Archivos listos", "done"],
      ["Conectando con DeepSeek V4 Pro", "done"],
    ])
    assert.equal(log[0].durationMs, 1840)
    assert.equal(log[1].endedAt, undefined, "a replayed trace is settled without a wall-clock end")
  })

  it("forwards start, note, phase and duration to the placeholder rows", () => {
    let log = appendActivity([], { label: "Leyendo el archivo adjunto", tool: "read_file" }, 1000)
    log = appendActivity(log, begin("pipe:web:2", "Buscando en la web · “cobre 2026”", { tool: "web_search", detail: "3 proveedores" }), 2500)
    log = appendActivity(log, { type: "stage", step: "tool_result", status: "done", ok: true, stageId: "pipe:web:2", label: "Fuentes encontradas", detail: "12 fuentes · reuters.com", elapsedMs: 3400 }, 5900)
    log = appendActivity(log, begin("pipe:model:3", "Conectando con DeepSeek V4 Pro", { tool: "model" }), 6000)
    const steps = activityToPlaceholderSteps(log)
    assert.deepEqual(steps.map((s) => [s.label, s.status, s.at, s.durationMs, s.detail]), [
      ["Leyendo el archivo adjunto", "done", 1000, 1500, undefined],
      ["Fuentes encontradas", "done", 2500, 3400, "12 fuentes · reuters.com"],
      ["Conectando con DeepSeek V4 Pro", "executing", 6000, undefined, undefined],
    ])
    assert.equal(steps[1].phase, "web")
    assert.equal(steps[1].verbatim, true, "backend phrases are shown as-is")
    assert.equal(steps[0].verbatim, undefined)
  })
})
