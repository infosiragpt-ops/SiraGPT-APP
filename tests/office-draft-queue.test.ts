import test from "node:test"
import assert from "node:assert/strict"
import { createOfficeDraftQueue, type OfficeSaveStatus } from "../lib/office-draft-queue"

test("saves edits made during an in-flight save in order using confirmed baselines", async () => {
  let release!: () => void
  const first = new Promise<void>((resolve) => { release = resolve })
  const calls: Array<[string, string]> = []
  const states: OfficeSaveStatus[] = []
  const queue = createOfficeDraftQueue({ initial: "original", onStatus: (s) => states.push(s), persist: async (value, previous) => {
    calls.push([value, previous]); if (calls.length === 1) await first
  } })
  queue.change("one")
  const saved = queue.flush()
  queue.change("two")
  assert.equal(queue.flush(), saved)
  release()
  assert.equal(await saved, true)
  assert.deepEqual(calls, [["one", "original"], ["two", "one"]])
  assert.equal(queue.dirty, false)
  assert.equal(states[states.length - 1], "saved")
})
test("failed saves retain the draft and baseline for explicit retry", async () => {
  let available = false
  const queue = createOfficeDraftQueue({ initial: "original", onStatus: () => {}, persist: async (_, baseline) => {
    assert.equal(baseline, "original"); if (!available) throw new Error("offline")
  } })
  queue.change("changed")
  assert.equal(await queue.flush(), false)
  queue.sync("some other window")
  assert.equal(queue.dirty, true)
  available = true
  assert.equal(await queue.flush(), true)
  assert.equal(queue.dirty, false)
})
