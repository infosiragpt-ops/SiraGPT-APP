import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"

import {
  goAgentsHistory,
  recordAgentsVisit,
  resetAgentsSessionHistory,
  snapshotAgentsHistory,
} from "../lib/agents-session-history"

describe("agents session history", () => {
  beforeEach(() => {
    resetAgentsSessionHistory()
  })

  it("seeds the first visit without enabling back", () => {
    recordAgentsVisit("a")
    const snap = snapshotAgentsHistory()
    assert.equal(snap.canBack, false)
    assert.equal(snap.canForward, false)
    assert.equal(snap.current, "a")
  })

  it("moves back and forward across visited chats", () => {
    recordAgentsVisit("a")
    recordAgentsVisit("b")
    recordAgentsVisit("c")
    assert.equal(snapshotAgentsHistory().canBack, true)
    assert.equal(goAgentsHistory(-1), "b")
    assert.equal(goAgentsHistory(-1), "a")
    assert.equal(snapshotAgentsHistory().canBack, false)
    assert.equal(snapshotAgentsHistory().canForward, true)
    assert.equal(goAgentsHistory(1), "b")
    assert.equal(goAgentsHistory(1), "c")
    assert.equal(snapshotAgentsHistory().canForward, false)
  })

  it("truncates the forward stack after a new visit", () => {
    recordAgentsVisit("a")
    recordAgentsVisit("b")
    goAgentsHistory(-1)
    recordAgentsVisit("c")
    const snap = snapshotAgentsHistory()
    assert.equal(snap.current, "c")
    assert.equal(snap.canForward, false)
    assert.equal(goAgentsHistory(-1), "a")
  })

  it("ignores duplicate consecutive visits including empty home", () => {
    recordAgentsVisit(null)
    recordAgentsVisit("")
    recordAgentsVisit("a")
    recordAgentsVisit("a")
    assert.equal(snapshotAgentsHistory().current, "a")
    assert.equal(goAgentsHistory(-1), "")
    assert.equal(goAgentsHistory(-1), null)
  })

  it("returns the same snapshot object when nothing changed", () => {
    recordAgentsVisit("a")
    const first = snapshotAgentsHistory()
    const second = snapshotAgentsHistory()
    assert.equal(first, second)
    assert.equal(first.current, "a")
    assert.equal(first.canBack, false)
    assert.equal(first.canForward, false)
  })

  it("allocates a new snapshot after visiting a different chat", () => {
    recordAgentsVisit("a")
    const first = snapshotAgentsHistory()
    recordAgentsVisit("b")
    const second = snapshotAgentsHistory()
    assert.notEqual(first, second)
    assert.equal(second.current, "b")
    assert.equal(second.canBack, true)
    assert.equal(second.canForward, false)
    assert.equal(first.current, "a")
  })

  it("keeps the snapshot reference after a duplicate visit of the current chat", () => {
    recordAgentsVisit("a")
    const first = snapshotAgentsHistory()
    recordAgentsVisit("a")
    const second = snapshotAgentsHistory()
    assert.equal(first, second)
    assert.equal(second.current, "a")
    assert.equal(second.canBack, false)
  })
})
