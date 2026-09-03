import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"

import { EFFORT_DITHER_SPEC, EffortDitherTrack } from "@/components/chat/effort-dither-track"

describe("EffortDitherTrack — dithered pixel dissolve", () => {
  it("partitions the tile into disjoint layers that together cover every cell", () => {
    const { tile, layerSizes, layers } = EFFORT_DITHER_SPEC
    const total = tile.cols * tile.rows
    expect(layerSizes.reduce((sum, n) => sum + n, 0)).toBe(total)
    expect(layers).toHaveLength(layerSizes.length)
    const seen = new Set<string>()
    layers.forEach((cells, index) => {
      expect(cells).toHaveLength(layerSizes[index])
      for (const [col, row] of cells) {
        expect(col).toBeGreaterThanOrEqual(0)
        expect(col).toBeLessThan(tile.cols)
        expect(row).toBeGreaterThanOrEqual(0)
        expect(row).toBeLessThan(tile.rows)
        const key = `${col},${row}`
        expect(seen.has(key), `cell ${key} appears in two layers`).toBe(false)
        seen.add(key)
      }
    })
    expect(seen.size).toBe(total)
  })

  it("ramps density and opacity from left to right, with isolated particles first", () => {
    const { layerRamps, layerSizes, solidRamp, layers } = EFFORT_DITHER_SPEC
    // Sparse → dense: every layer adds at least as many pixels as the previous one.
    for (let i = 1; i < layerSizes.length; i += 1) expect(layerSizes[i]).toBeGreaterThanOrEqual(layerSizes[i - 1])
    // Each layer fades in later than the one before, and every ramp is a valid [0,1] window.
    for (let i = 0; i < layerRamps.length; i += 1) {
      const [from, to] = layerRamps[i]
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeLessThanOrEqual(1)
      expect(to).toBeGreaterThan(from)
      if (i > 0) {
        expect(from).toBeGreaterThan(layerRamps[i - 1][0])
        expect(to).toBeGreaterThan(layerRamps[i - 1][1])
      }
    }
    // Particles start at the very left; the solid cap only covers the far right.
    expect(layerRamps[0][0]).toBe(0)
    expect(solidRamp[0]).toBeGreaterThan(0.75)
    expect(solidRamp[1]).toBe(1)
    // The particle layer holds two cells far apart (not a pair).
    const [[c1, r1], [c2, r2]] = layers[0]
    expect(Math.abs(c1 - c2) + Math.abs(r1 - r2)).toBeGreaterThanOrEqual(6)
  })

  it("keeps pixels square in user space and renders deterministic SVG markup", () => {
    const { cell, pixel } = EFFORT_DITHER_SPEC
    expect(pixel).toBeLessThan(cell)
    expect(Number.isInteger(cell) && Number.isInteger(pixel)).toBe(true)

    const first = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    const second = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    expect(first).toBe(second)
    expect(first).toContain('patternUnits="userSpaceOnUse"')
    expect(first).toContain('class="effort-dither-base"')
    expect(first).toContain('class="effort-dither-px"')
    expect(first).not.toMatch(/<image|data:image/)
    // Six pixel layers + the solid cap, each behind its own mask.
    expect((first.match(/<pattern /g) || []).length).toBe(EFFORT_DITHER_SPEC.layerSizes.length)
    expect((first.match(/<mask /g) || []).length).toBe(EFFORT_DITHER_SPEC.layerSizes.length + 1)
    // Every pixel rect is exactly `pixel` wide/tall.
    const sizes = [...first.matchAll(/class="effort-dither-px" x="[\d.]+" y="[\d.]+" width="(\d+)" height="(\d+)"/g)]
    expect(sizes.length).toBe(EFFORT_DITHER_SPEC.tile.cols * EFFORT_DITHER_SPEC.tile.rows)
    for (const [, w, h] of sizes) {
      expect(Number(w)).toBe(pixel)
      expect(Number(h)).toBe(pixel)
    }
  })
})
