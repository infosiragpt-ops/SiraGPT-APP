import * as THREE from "three"
import { afterEach, describe, expect, it, vi } from "vitest"

import { addEdgeDistrict } from "@/components/code/agent-office/agent-office-city"

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

  it("builds a tall glass skyline and premium terrace within a fixed draw-call budget", () => {
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

    // secondaryCount full = 52 → landmark + secondaries = 53 denser modern CBD.
    expect(district.counts.buildings).toBe(53)
    expect(district.counts.signatureTowers).toBeGreaterThanOrEqual(8)
    expect(district.counts.architecturalCrowns).toBeGreaterThanOrEqual(16)
    // 2 glass planes per secondary (+ optional sky-bridge panes).
    expect(district.counts.glassFacades).toBeGreaterThanOrEqual(104)
    expect(district.counts.glassFacades).toBeLessThanOrEqual(112)
    expect(district.counts.terraceAmenities).toBeGreaterThanOrEqual(24)
    expect(district.counts.tallestBuildingHeight).toBeGreaterThanOrEqual(55)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(28)
    expect(district.counts.windows).toBeGreaterThanOrEqual(2_000)

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

    // secondaryCount thumbnail = 22 → landmark + secondaries = 23.
    expect(district.counts.buildings).toBe(23)
    expect(district.counts.glassFacades).toBe(44)
    expect(district.counts.vehicles).toBe(4)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(28)

    dispose(scene)
  })
})
