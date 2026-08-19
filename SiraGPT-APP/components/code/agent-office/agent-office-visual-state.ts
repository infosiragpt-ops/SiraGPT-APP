export type AgentOfficeHexColor = {
  setHex: (value: number) => unknown
}

export type AgentOfficeStationVisualTarget = {
  screens: Array<{
    material: {
      color: AgentOfficeHexColor
      emissive: AgentOfficeHexColor
      emissiveIntensity: number
    }
  }>
  edgeGlowMaterial: {
    color: AgentOfficeHexColor
    opacity: number
  }
  lampGlowMaterial: {
    color: AgentOfficeHexColor
    opacity: number
  }
  activeBeacon: { visible: boolean }
}

export function agentOfficeWorkerStationVisualState(active: boolean) {
  return active
    ? {
        screenColor: 0xa8e8ff,
        screenEmissive: 0x0e4f66,
        screenIntensity: 1.25,
        edgeColor: 0x5ee1f2,
        edgeOpacity: 0.85,
        lampColor: 0xb8f0ff,
        lampOpacity: 0.95,
      }
    : {
        screenColor: 0x5f758c,
        screenEmissive: 0x0b1220,
        screenIntensity: 0.22,
        edgeColor: 0x7a93a0,
        edgeOpacity: 0.35,
        lampColor: 0xf4dfad,
        lampOpacity: 0.55,
      }
}

export function applyAgentOfficeWorkerStationVisualState(
  target: AgentOfficeStationVisualTarget,
  active: boolean,
) {
  const visual = agentOfficeWorkerStationVisualState(active)
  for (const screen of target.screens) {
    screen.material.color.setHex(visual.screenColor)
    screen.material.emissive.setHex(visual.screenEmissive)
    screen.material.emissiveIntensity = visual.screenIntensity
  }
  target.edgeGlowMaterial.color.setHex(visual.edgeColor)
  target.edgeGlowMaterial.opacity = visual.edgeOpacity
  target.lampGlowMaterial.color.setHex(visual.lampColor)
  target.lampGlowMaterial.opacity = visual.lampOpacity
  target.activeBeacon.visible = active
  return visual
}
