import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  activityDurationMs,
  activityToPlaceholderSteps,
  appendActivity,
  finalizeActivity,
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
