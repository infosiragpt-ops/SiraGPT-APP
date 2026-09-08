import assert from "node:assert/strict"
import test from "node:test"

import {
  agentOfficeWorkerStationVisualState,
  applyAgentOfficeWorkerStationVisualState,
} from "../components/code/agent-office/agent-office-visual-state"

function colorRecorder() {
  return {
    value: -1,
    setHex(value: number) {
      this.value = value
    },
  }
}

test("live station state updates both monitors, edge, lamp and beacon", () => {
  const screens = [0, 1].map(() => ({
    material: {
      color: colorRecorder(),
      emissive: colorRecorder(),
      emissiveIntensity: 0,
    },
  }))
  const edgeGlowMaterial = { color: colorRecorder(), opacity: 0 }
  const lampGlowMaterial = { color: colorRecorder(), opacity: 0 }
  const activeBeacon = { visible: false }
  const target = { screens, edgeGlowMaterial, lampGlowMaterial, activeBeacon }

  applyAgentOfficeWorkerStationVisualState(target, true)
  const active = agentOfficeWorkerStationVisualState(true)
  assert.deepEqual(
    screens.map((screen) => screen.material.color.value),
    [active.screenColor, active.screenColor],
  )
  assert.deepEqual(
    screens.map((screen) => screen.material.emissive.value),
    [active.screenEmissive, active.screenEmissive],
  )
  assert.equal(edgeGlowMaterial.color.value, active.edgeColor)
  assert.equal(lampGlowMaterial.color.value, active.lampColor)
  assert.equal(activeBeacon.visible, true)

  applyAgentOfficeWorkerStationVisualState(target, false)
  const idle = agentOfficeWorkerStationVisualState(false)
  assert.deepEqual(
    screens.map((screen) => screen.material.color.value),
    [idle.screenColor, idle.screenColor],
  )
  assert.deepEqual(
    screens.map((screen) => screen.material.emissive.value),
    [idle.screenEmissive, idle.screenEmissive],
  )
  assert.equal(edgeGlowMaterial.color.value, idle.edgeColor)
  assert.equal(edgeGlowMaterial.opacity, idle.edgeOpacity)
  assert.equal(lampGlowMaterial.color.value, idle.lampColor)
  assert.equal(lampGlowMaterial.opacity, idle.lampOpacity)
  assert.equal(activeBeacon.visible, false)
})
