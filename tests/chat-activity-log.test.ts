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
