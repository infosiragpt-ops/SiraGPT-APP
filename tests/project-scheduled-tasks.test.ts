import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  parseProjectScheduledTasks,
  projectScheduledStorageKey,
} from "../lib/project-scheduled-tasks"

describe("project scheduled tasks", () => {
  it("builds a stable storage key per project", () => {
    assert.equal(projectScheduledStorageKey("abc"), "sira:project-scheduled:abc")
  })

  it("parses valid tasks and drops junk", () => {
    const tasks = parseProjectScheduledTasks([
      { id: "1", name: "Resumen diario", instructions: "Cinco puntos", frequency: "daily", approval: "manual", requireComputer: true, createdAt: "2026-08-27" },
      { id: "1", name: "dup" },
      { name: "no-id" },
      null,
    ])
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].name, "Resumen diario")
    assert.equal(tasks[0].frequency, "daily")
    assert.equal(tasks[0].requireComputer, true)
  })
})
