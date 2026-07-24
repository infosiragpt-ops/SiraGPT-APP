import assert from "node:assert/strict"
import test from "node:test"

import {
  nextOfficeTimeMode,
  officeTimeModeLabel,
  officeTimeOfDay,
  officeTimePhase,
  officeTimePhaseLabel,
  officeTimePhaseModeLabel,
  resolveOfficeTimeOfDay,
  resolveOfficeTimePhase,
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

test("officeTimePhase refines the day window into dawn, day and dusk", () => {
  assert.equal(officeTimePhase(localDate(6)), "dawn")
  assert.equal(officeTimePhase(localDate(7, 59)), "dawn")
  assert.equal(officeTimePhase(localDate(8)), "day")
  assert.equal(officeTimePhase(localDate(15, 59)), "day")
  assert.equal(officeTimePhase(localDate(16)), "dusk")
  assert.equal(officeTimePhase(localDate(17, 59)), "dusk")
  assert.equal(officeTimePhase(localDate(18)), "night")
  assert.equal(officeTimePhase(localDate(3)), "night")
})

test("officeTimePhase never contradicts the day/night structure", () => {
  // The scene keys sky, stars and interior lamps off officeTimeOfDay while the
  // lighting warmth keys off the phase. A dawn/dusk phase during the night
  // window (or a night phase at noon) would light a starfield with a sunset.
  for (let hour = 0; hour < 24; hour += 1) {
    const date = localDate(hour)
    const phase = officeTimePhase(date)
    const expected = phase === "night" ? "night" : "day"
    assert.equal(officeTimeOfDay(date), expected, `hour ${hour} phase ${phase}`)
  }
})

test("manual office time mode also pins the lighting phase", () => {
  assert.equal(resolveOfficeTimePhase("auto", localDate(17)), "dusk")
  assert.equal(resolveOfficeTimePhase("day", localDate(23)), "day")
  assert.equal(resolveOfficeTimePhase("night", localDate(12)), "night")
})

test("phase labels name the resolved moment in the header", () => {
  assert.equal(officeTimePhaseLabel("dawn"), "Amanecer")
  assert.equal(officeTimePhaseLabel("dusk"), "Atardecer")
  assert.equal(officeTimePhaseModeLabel("auto", "dusk"), "Auto · Atardecer")
  assert.equal(officeTimePhaseModeLabel("night", "night"), "Noche")
})

test("office time control cycles and exposes a concise visible label", () => {
  assert.equal(nextOfficeTimeMode("auto"), "day")
  assert.equal(nextOfficeTimeMode("day"), "night")
  assert.equal(nextOfficeTimeMode("night"), "auto")
  assert.equal(officeTimeModeLabel("auto", "night"), "Auto · Noche")
  assert.equal(officeTimeModeLabel("day", "day"), "Día")
})
