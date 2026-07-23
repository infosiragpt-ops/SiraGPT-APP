import assert from "node:assert/strict"
import test from "node:test"

import {
  nextOfficeTimeMode,
  officeTimeModeLabel,
  officeTimeOfDay,
  resolveOfficeTimeOfDay,
} from "../lib/agent-office-environment"

function localDate(hour: number, minute = 0) {
  return new Date(2026, 6, 23, hour, minute, 0, 0)
}

test("officeTimeOfDay follows the local daytime window", () => {
  assert.equal(officeTimeOfDay(localDate(5, 59)), "night")
  assert.equal(officeTimeOfDay(localDate(6)), "day")
  assert.equal(officeTimeOfDay(localDate(17, 59)), "day")
  assert.equal(officeTimeOfDay(localDate(18)), "night")
})

test("manual office time mode overrides the local clock", () => {
  assert.equal(resolveOfficeTimeOfDay("day", localDate(23)), "day")
  assert.equal(resolveOfficeTimeOfDay("night", localDate(12)), "night")
  assert.equal(resolveOfficeTimeOfDay("auto", localDate(12)), "day")
})

test("office time control cycles and exposes a concise visible label", () => {
  assert.equal(nextOfficeTimeMode("auto"), "day")
  assert.equal(nextOfficeTimeMode("day"), "night")
  assert.equal(nextOfficeTimeMode("night"), "auto")
  assert.equal(officeTimeModeLabel("auto", "night"), "Auto · Noche")
  assert.equal(officeTimeModeLabel("day", "day"), "Día")
})
