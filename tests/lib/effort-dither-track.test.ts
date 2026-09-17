import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"

import { EFFORT_DITHER_SPEC, EffortDitherTrack } from "@/components/chat/effort-dither-track"

describe("EffortDitherTrack — advanced left→right pixel dissolve", () => {
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

  it("orders the dissolve with a Bayer matrix: deterministic halftone, not random scatter", () => {
    const { layers, layerSizes, bayerValue } = EFFORT_DITHER_SPEC
    // Cells arrive in non-decreasing Bayer order across the layer sequence.
    const flat = layers.flat()
    for (let i = 1; i < flat.length; i += 1) {
      const prev = bayerValue(flat[i - 1][0], flat[i - 1][1])
      const next = bayerValue(flat[i][0], flat[i][1])
      expect(next).toBeGreaterThanOrEqual(prev)
    }
    // The sparse first layer holds the lowest values of the whole tile and the
    // dense last layer holds the highest: the classic halftone progression.
    const allValues = flat.map(([c, r]) => bayerValue(c, r)).sort((a, b) => a - b)
    const firstLayerValues = layers[0].map(([c, r]) => bayerValue(c, r)).sort((a, b) => a - b)
    const lastLayerValues = layers[layers.length - 1].map(([c, r]) => bayerValue(c, r)).sort((a, b) => a - b)
    expect(firstLayerValues).toEqual(allValues.slice(0, layerSizes[0]))
    expect(lastLayerValues).toEqual(allValues.slice(-layerSizes[layerSizes.length - 1]))
  })

  it("grows density and opacity toward the right, with light particles first", () => {
    const { layerRamps, layerSizes, depthClass, rampStops } = EFFORT_DITHER_SPEC
    expect(layerRamps).toHaveLength(layerSizes.length)
    // Every ramp is a valid left→right window, and later layers start and
    // finish further right so density climbs toward the active stop.
    for (let i = 0; i < layerRamps.length; i += 1) {
      const [from, to] = layerRamps[i]
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeLessThanOrEqual(1)
      expect(to).toBeGreaterThan(from)
      if (i > 0) {
        expect(from).toBeGreaterThanOrEqual(layerRamps[i - 1][0])
        expect(to).toBeGreaterThan(layerRamps[i - 1][1])
      }
    }
    // Particles start at the very left; the full grid completes before the end.
    expect(layerRamps[0][0]).toBe(0)
    expect(layerRamps[layerRamps.length - 1][1]).toBeLessThanOrEqual(1)
    // Ramp stops fade in then hold opaque (gradients keep their last stop).
    for (const [from, to] of layerRamps) {
      expect(rampStops(from, to)).toEqual([
        [from, 0],
        [to, 1],
      ])
    }
    // Color depth tiers: light particles → base violet → deep violet.
    const last = layerSizes.length - 1
    expect(depthClass(0)).toContain("effort-dither-px-light")
    expect(depthClass(last)).toContain("effort-dither-px-deep")
    expect(depthClass(Math.floor(last / 2))).toBe("effort-dither-px")
  })

  it("glows a soft core and glints white sparkles only in the dense right zone", () => {
    const { coreRamp, sparkleCells, sparkleRamp, sparkleSize, layerRamps } = EFFORT_DITHER_SPEC
    expect(coreRamp[0]).toBeGreaterThan(0)
    expect(coreRamp[1]).toBeLessThanOrEqual(1)
    expect(coreRamp[1]).toBeGreaterThan(coreRamp[0])
    // Sparkles live inside the dense right side, after most layers started.
    expect(sparkleRamp[0]).toBeGreaterThan(layerRamps[0][1])
    expect(sparkleRamp[1]).toBeLessThanOrEqual(1)
    expect(sparkleRamp[1]).toBeGreaterThan(sparkleRamp[0])
    expect(sparkleCells).toHaveLength(sparkleSize)
    expect(sparkleSize).toBeGreaterThan(0)
    const markup = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    expect((markup.match(/class="effort-dither-spark"/g) || []).length).toBe(sparkleSize)
    expect(markup).toContain('class="effort-dither-core"')
    expect(markup).toContain('class="effort-dither-sparkle-layer"')
    // No sparkle rect shimmers.
    expect((markup.match(/effort-dither-spark"/g) || []).length).toBe(sparkleSize)
  })

  it("twinkles only light layers with deterministic position-derived delays", () => {
    const { twinkleLayers, twinklePeriodS, twinkleDelayS } = EFFORT_DITHER_SPEC
    expect(twinkleLayers).toBeGreaterThan(0)
    expect(twinkleLayers).toBeLessThan(EFFORT_DITHER_SPEC.layerSizes.length)
    const markup = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    const twinkles = [...markup.matchAll(/class="effort-dither-px effort-dither-px-light effort-dither-twinkle"[^>]*style="animation-delay:([\d.]+)s"/g)]
    const expected = EFFORT_DITHER_SPEC.layerSizes
      .slice(0, twinkleLayers)
      .reduce((sum, n) => sum + n, 0)
    expect(twinkles.length).toBe(expected)
    // No other pixel rect carries the twinkle class or an animation delay.
    expect((markup.match(/effort-dither-twinkle/g) || []).length).toBe(expected)
    expect((markup.match(/animation-delay/g) || []).length).toBe(expected)
    for (const [, delay] of twinkles) {
      const seconds = Number(delay)
      expect(seconds).toBeGreaterThanOrEqual(0)
      expect(seconds).toBeLessThan(twinklePeriodS)
    }
    // Delay is a pure function of grid position: column-major wave.
    expect(twinkleDelayS(0, 0)).toBe(0)
    expect(twinkleDelayS(4, 0)).toBeCloseTo(1.4, 10)
    expect(twinkleDelayS(0, 2)).toBeCloseTo(0.26, 10)
  })

  it("keeps pixels square in user space and renders deterministic SVG markup", () => {
    const { cell, pixel, tile } = EFFORT_DITHER_SPEC
    expect(pixel).toBeLessThan(cell)
    expect(Number.isInteger(cell) && Number.isInteger(pixel)).toBe(true)

    const first = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    const second = renderToStaticMarkup(createElement(EffortDitherTrack, { className: "effort-dither" }))
    expect(first).toBe(second)
    expect(first).toContain('patternUnits="userSpaceOnUse"')
    expect(first).toContain('class="effort-dither-base"')
    expect(first).toContain('class="effort-dither-px"')
    expect(first).toContain("effort-dither-px-light")
    expect(first).toContain("effort-dither-px-deep")
    expect(first).not.toMatch(/<image|data:image/)
    // One pattern per pixel layer + the sparkle pattern; one mask per layer
    // plus the core and sparkle masks.
    expect((first.match(/<pattern /g) || []).length).toBe(EFFORT_DITHER_SPEC.layerSizes.length + 1)
    expect((first.match(/<mask /g) || []).length).toBe(EFFORT_DITHER_SPEC.layerSizes.length + 2)
    // Every pixel rect is exactly `pixel` wide/tall (violet or sparkle).
    const sizes = [...first.matchAll(/class="effort-dither-(?:px(?: effort-dither-px-(?:light|deep))?(?: effort-dither-twinkle)?|spark)"(?: style="[^"]*")? x="[\d.]+" y="[\d.]+" width="(\d+)" height="(\d+)"/g)]
    expect(sizes.length).toBe(tile.cols * tile.rows + EFFORT_DITHER_SPEC.sparkleSize)
    for (const [, w, h] of sizes) {
      expect(Number(w)).toBe(pixel)
      expect(Number(h)).toBe(pixel)
    }
  })
})
