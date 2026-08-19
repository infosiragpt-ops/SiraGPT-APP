import * as THREE from "three"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addEdgeDistrict,
  HQ_FLOOR_TO_FLOOR,
  HQ_STACKED_FLOORS_FULL,
  HQ_STACKED_FLOORS_THUMBNAIL,
} from "@/components/code/agent-office/agent-office-city"

function dispose(scene: THREE.Scene) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : []
    for (const material of materials) material.dispose()
  })
}

describe("agent office Edge District", () => {
  afterEach(() => vi.restoreAllMocks())

  it("builds a 120-storey glass HQ and dense blue CBD within the draw-call budget", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null)
    const scene = new THREE.Scene()
    const district = addEdgeDistrict({
      scene,
      totalWidth: 34.6,
      totalDepth: 26.2,
      timeOfDay: "night",
      timePhase: "night",
      light: { background: 0x0b1d2c, fog: 0x11283a, horizon: 0x31485b },
      variant: "full",
    })

    // secondaryCount full = 72 → landmark + secondaries = 73 denser modern CBD.
    expect(district.counts.buildings).toBe(73)
    expect(district.counts.secondaryBuildings).toBe(72)
    expect(district.counts.hqStackedFloors).toBe(HQ_STACKED_FLOORS_FULL)
    expect(district.counts.hqFloorHeight).toBe(HQ_FLOOR_TO_FLOOR)
    expect(district.counts.signatureTowers).toBeGreaterThanOrEqual(8)
    expect(district.counts.architecturalCrowns).toBeGreaterThanOrEqual(16)
    // 4 glass planes per secondary (+ HQ per-floor panes + optional sky-bridges).
    expect(district.counts.glassFacades).toBeGreaterThanOrEqual(500)
    expect(district.counts.terraceAmenities).toBeGreaterThanOrEqual(24)
    expect(district.counts.tallestBuildingHeight).toBeGreaterThanOrEqual(460)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(28)
    expect(district.counts.windows).toBeGreaterThanOrEqual(1_800)
    expect(district.counts.vehicles).toBeGreaterThanOrEqual(16)
    expect(district.framing.officeY).toBe(0)
    expect(district.framing.groundY).toBeCloseTo(-HQ_STACKED_FLOORS_FULL * HQ_FLOOR_TO_FLOOR, 5)
    expect(district.framing.groundY).toBeCloseTo(-462, 5)
    expect(district.framing.pitch).toBeGreaterThanOrEqual(0.6)
    expect(district.framing.portraitPitch).toBeGreaterThanOrEqual(0.8)
    expect(district.framing.target.y).toBeLessThan(2)
    expect(
      district.framing.target.y
      + district.framing.portraitTargetLift,
    ).toBeLessThan(2)
    const facadeFront = (26.2 + 26) / 2
    const sightlineOverFacade = district.framing.target.y
      + facadeFront * Math.tan(district.framing.pitch) / Math.cos(district.framing.yaw)
    expect(sightlineOverFacade).toBeGreaterThan(14)

    dispose(scene)
  })

  it("keeps the thumbnail skyline intentionally bounded", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null)
    const scene = new THREE.Scene()
    const district = addEdgeDistrict({
      scene,
      totalWidth: 24,
      totalDepth: 12,
      timeOfDay: "day",
      timePhase: "day",
      light: { background: 0xadd3e2, fog: 0xb9d8e2, horizon: 0xd1e6eb },
      variant: "thumbnail",
    })

    // secondaryCount thumbnail = 28 → landmark + secondaries = 29.
    expect(district.counts.buildings).toBe(29)
    expect(district.counts.secondaryBuildings).toBe(28)
    expect(district.counts.hqStackedFloors).toBe(HQ_STACKED_FLOORS_THUMBNAIL)
    expect(district.counts.hqFloorHeight).toBe(HQ_FLOOR_TO_FLOOR)
    expect(district.counts.tallestBuildingHeight).toBeGreaterThanOrEqual(180)
    expect(district.counts.glassFacades).toBeGreaterThanOrEqual(112)
    expect(district.counts.vehicles).toBe(6)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(28)
    expect(district.framing.groundY).toBeCloseTo(-HQ_STACKED_FLOORS_THUMBNAIL * HQ_FLOOR_TO_FLOOR, 5)
    expect(district.framing.pitch).toBe(0.48)
    expect(district.framing.portraitPitch).toBe(0.48)
    expect(district.framing.portraitTargetLift).toBe(2.8)

    dispose(scene)
  })
})
