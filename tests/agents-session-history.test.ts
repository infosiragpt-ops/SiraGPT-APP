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
})
