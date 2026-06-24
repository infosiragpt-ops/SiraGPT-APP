import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  initialAgentState,
  reduceEvent,
  type AgentTaskState,
} from "../lib/agent-task-service"

/**
 * The base agent-task-service test covers the most common
 * step_start / tool_call ordering pair. This file exercises the
 * other reduceEvent branches: queue / artifacts / approvals /
 * checkpoints / quality_gates / repairs / step_done / final_text /
 * done / error. The state is treated as opaque except for the
 * branches each event mutates.
 */

function fresh(): AgentTaskState {
  // Clone so individual tests can mutate freely.
  return JSON.parse(JSON.stringify(initialAgentState))
}

describe("reduceEvent · queue_status", () => {
  it("captures the queue snapshot including null position / ETA", () => {
    const next = reduceEvent(fresh(), {
      type: "queue_status",
      status: "queued",
      queue: "high",
      jobId: "job-1",
      position: null,
      estimatedWaitMs: null,
      ts: "2026-05-16T10:00:00Z",
    })
    assert.equal(next.queue?.status, "queued")
    assert.equal(next.queue?.queue, "high")
    assert.equal(next.queue?.jobId, "job-1")
    assert.equal(next.queue?.position, null)
    assert.equal(next.queue?.estimatedWaitMs, null)
    assert.equal(next.queue?.updatedAt, "2026-05-16T10:00:00Z")
  })
})

describe("reduceEvent · file_artifact", () => {
  it("appends to the artifacts list (does NOT replace)", () => {
    let s = fresh()
    s = reduceEvent(s, {
      type: "file_artifact",
      artifact: { id: "a1", filename: "x.pdf", mime: "application/pdf", sizeBytes: 10, downloadUrl: "/x" },
    } as any)
    s = reduceEvent(s, {
      type: "file_artifact",
      artifact: { id: "a2", filename: "y.docx", mime: "application/docx", sizeBytes: 20, downloadUrl: "/y" },
    } as any)
    assert.equal(s.artifacts.length, 2)
    assert.equal(s.artifacts[0].id, "a1")
    assert.equal(s.artifacts[1].id, "a2")
  })
})

describe("reduceEvent · checkpoints", () => {
  it("appends checkpoints and fills missing id/label", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "checkpoint", id: "c1", label: "first" } as any)
    s = reduceEvent(s, { type: "checkpoint" } as any)
    assert.equal(s.checkpoints!.length, 2)
    assert.equal(s.checkpoints![0].id, "c1")
    assert.equal(s.checkpoints![0].label, "first")
    assert.match(s.checkpoints![1].id, /^checkpoint-/)
    assert.equal(s.checkpoints![1].label, "Checkpoint")
  })

  it("caps the checkpoint history at 20 entries (drops oldest)", () => {
    let s = fresh()
    for (let i = 0; i < 25; i++) {
      s = reduceEvent(s, { type: "checkpoint", id: `c${i}`, label: `step ${i}` } as any)
    }
    assert.equal(s.checkpoints!.length, 20)
    // First five (c0..c4) should have been dropped.
    assert.equal(s.checkpoints![0].id, "c5")
    assert.equal(s.checkpoints![19].id, "c24")
  })
})

describe("reduceEvent · quality_gates", () => {
  it("records pass/fail, score, and falls back to overallScore", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "quality_gate", id: "qg1", label: "schema", passed: true, score: 0.9 } as any)
    s = reduceEvent(s, { type: "quality_gate", id: "qg2", label: "rubric", passed: false, overallScore: 72 } as any)
    assert.equal(s.qualityGates!.length, 2)
    assert.equal(s.qualityGates![0].passed, true)
    assert.equal(s.qualityGates![0].score, 0.9)
    assert.equal(s.qualityGates![1].passed, false)
    assert.equal(s.qualityGates![1].score, 72)
  })

  it("coerces `passed` via Boolean (truthy => true, missing => false)", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "quality_gate", id: "qg1", label: "x", passed: 1 as any } as any)
    s = reduceEvent(s, { type: "quality_gate", id: "qg2", label: "y" } as any)
    assert.equal(s.qualityGates![0].passed, true)
    assert.equal(s.qualityGates![1].passed, false)
  })
})

describe("reduceEvent · repair_attempt", () => {
  it("assigns attempt via state.repairs.length+1 and caps at 10", () => {
    let s = fresh()
    for (let i = 0; i < 12; i++) {
      s = reduceEvent(s, { type: "repair_attempt", status: "running", message: `try ${i}` } as any)
    }
    assert.equal(s.repairs!.length, 10)
    // Quirk: once the cap kicks in, `state.repairs.length+1` plateaus
    // because the array is sliced back to 10 every iteration. So the
    // attempt number stops climbing at 11 even though more attempts
    // arrived. Pin this so any future "remember the max attempt"
    // change shows up here.
    assert.equal(s.repairs![9].attempt, 11)
  })
})

describe("reduceEvent · human approval lifecycle", () => {
  it("required adds a pending approval and resolved updates it in place", () => {
    let s = fresh()
    s = reduceEvent(s, {
      type: "human_approval_required",
      approvalId: "a1",
      tool: "write_file",
      reason: "wants to overwrite x",
    } as any)
    assert.equal(s.approvals!.length, 1)
    assert.equal(s.approvals![0].status, "pending")

    s = reduceEvent(s, {
      type: "human_approval_resolved",
      approvalId: "a1",
      decision: "approve",
      resolvedBy: "luis",
    } as any)
    // Same array length, updated in place.
    assert.equal(s.approvals!.length, 1)
    assert.equal(s.approvals![0].status, "approve")
    assert.equal(s.approvals![0].decision, "approve")
    assert.equal(s.approvals![0].resolvedBy, "luis")
  })

  it("resolved with an unseen approvalId appends a new entry", () => {
    const s = reduceEvent(fresh(), {
      type: "human_approval_resolved",
      approvalId: "ghost",
      decision: "reject",
    } as any)
    assert.equal(s.approvals!.length, 1)
    assert.equal(s.approvals![0].id, "ghost")
  })
})

describe("reduceEvent · step_done", () => {
  it("marks the matching step as 'done' on ok", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "step_start", id: "s1", label: "work" } as any)
    s = reduceEvent(s, { type: "step_done", id: "s1", ok: true } as any)
    assert.equal(s.steps[0].status, "done")
  })

  it("marks the matching step as 'error' on !ok", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "step_start", id: "s1", label: "work" } as any)
    s = reduceEvent(s, { type: "step_done", id: "s1", ok: false } as any)
    assert.equal(s.steps[0].status, "error")
  })

  it("ignores step_done for an unknown step id", () => {
    let s = fresh()
    s = reduceEvent(s, { type: "step_start", id: "s1", label: "work" } as any)
    s = reduceEvent(s, { type: "step_done", id: "ghost", ok: true } as any)
    // s1 still running.
    assert.equal(s.steps[0].status, "running")
  })
})

describe("reduceEvent · final_text / done / error", () => {
  it("final_text replaces the running finalText", () => {
    const s = reduceEvent(fresh(), { type: "final_text", markdown: "## Done" } as any)
    assert.equal(s.finalText, "## Done")
  })

  it("done flips done=true and records stoppedReason", () => {
    const s = reduceEvent(fresh(), {
      type: "done",
      stoppedReason: "ok",
      stats: { steps: 3, artifacts: 1 },
    } as any)
    assert.equal(s.done, true)
    assert.equal(s.stoppedReason, "ok")
  })

  it("error flips done=true and records the message", () => {
    const s = reduceEvent(fresh(), { type: "error", message: "boom" } as any)
    assert.equal(s.done, true)
    assert.equal(s.error, "boom")
  })
})

describe("reduceEvent · unknown event", () => {
  // Since the stale-stream fix (commit 6101919c1) EVERY event — heartbeats
  // and unknown types included — refreshes state.lastEventAt so the UI's
  // stale guard can tell "model thinking quietly" apart from "stream dead".
  // Nothing else may change, and the input state must not be mutated.
  it("only refreshes the liveness stamp for an unhandled type", () => {
    const before = fresh()
    const snapshot = JSON.parse(JSON.stringify(before))
    const after = reduceEvent(before, {
      type: "totally_unknown_event",
      ts: "2026-06-11T00:00:00.000Z",
    } as any)

    // The event's own ts wins as the liveness stamp.
    const { lastEventAt, ...rest } = after
    assert.equal(lastEventAt, "2026-06-11T00:00:00.000Z")
    // Everything else is untouched...
    assert.deepEqual(rest, snapshot)
    // ...and the reducer stays pure: the input object was not mutated.
    assert.deepEqual(before, snapshot)
  })

  it("falls back to a fresh ISO timestamp when the event has no ts", () => {
    const t0 = Date.now()
    const after = reduceEvent(fresh(), { type: "totally_unknown_event" } as any)
    assert.ok(after.lastEventAt, "lastEventAt should be stamped")
    const stamped = Date.parse(after.lastEventAt!)
    assert.ok(
      stamped >= t0 - 1000 && stamped <= Date.now() + 1000,
      `lastEventAt (${after.lastEventAt}) should be ~now`,
    )
  })
})
