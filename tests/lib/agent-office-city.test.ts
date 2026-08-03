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

    expect(district.counts.buildings).toBe(31)
    expect(district.counts.signatureTowers).toBeGreaterThanOrEqual(6)
    expect(district.counts.architecturalCrowns).toBeGreaterThanOrEqual(12)
    expect(district.counts.glassFacades).toBe(60)
    expect(district.counts.terraceAmenities).toBeGreaterThanOrEqual(20)
    expect(district.counts.tallestBuildingHeight).toBeGreaterThanOrEqual(44)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(24)
    expect(district.counts.windows).toBeGreaterThanOrEqual(1_500)

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

    expect(district.counts.buildings).toBe(15)
    expect(district.counts.glassFacades).toBe(28)
    expect(district.counts.vehicles).toBe(4)
    expect(district.counts.expectedDrawCalls).toBeLessThanOrEqual(24)

    dispose(scene)
  })
})
