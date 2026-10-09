import { describe, expect, it } from "vitest"
import {
  ARM_DIRECTIONS,
  ARM_RANKS,
  LOGO_GEOMETRY,
  LOGO_GEOMETRY_SMALL,
  SHOWCASE_GEOMETRY,
  SHOWCASE_TIMING,
  SIRA_TIMING,
  frameAt,
  logoGeometryFor,
  openFrame,
  progressAt,
  siraMarkSvg,
  smooth,
} from "@/lib/brand/sira-motion"

describe("sira-motion — the brand motion model", () => {
  it("has eight arms, north first and clockwise, with opposite arms sharing a rank", () => {
    expect(ARM_DIRECTIONS).toHaveLength(8)
    expect(ARM_DIRECTIONS[0]).toMatchObject({ x: 0, y: -1, rank: 0 })
    expect(ARM_DIRECTIONS[2]).toMatchObject({ x: 1, y: 0, rank: 1 })
    expect(ARM_DIRECTIONS[4]).toMatchObject({ x: 0, y: 1, rank: 0 })
    for (let i = 0; i < 4; i += 1) expect(ARM_RANKS[i]).toBe(ARM_RANKS[i + 4])
    // The delivered rank table: N/S first, E/W second, NE/SW third, SE/NW last.
    expect([...ARM_RANKS]).toEqual([0, 2, 1, 3, 0, 2, 1, 3])
    expect(ARM_DIRECTIONS.map((d) => d.rank)).toEqual([...ARM_RANKS])
  })

  it("smooth is a quintic smoothstep clamped to [0, 1]", () => {
    expect(smooth(-1)).toBe(0)
    expect(smooth(0)).toBe(0)
    expect(smooth(0.5)).toBe(0.5)
    expect(smooth(1)).toBe(1)
    expect(smooth(2)).toBe(1)
    // zero slope at both ends
    expect(smooth(0.001)).toBeLessThan(1e-7)
    expect(1 - smooth(0.999)).toBeLessThan(1e-7)
  })

  it("keeps the delivered showcase timing and ships the 1.5 s product cycle: open for the first half, closed at the end", () => {
    expect(SHOWCASE_TIMING).toEqual({ cycle: 2000, start: 0, duration: 970, close: 1000, stagger: 10 })
    // Jorge (2026-10-09): open and close in 1–1.5 s. The last rank finishes
    // opening exactly when the closing starts (duration = close − 3·stagger).
    expect(SIRA_TIMING).toEqual({ cycle: 1500, start: 0, duration: 720, close: 750, stagger: 10 })
    expect(SIRA_TIMING.close).toBe(SIRA_TIMING.cycle / 2)
    expect(SIRA_TIMING.duration).toBe(SIRA_TIMING.close - 3 * SIRA_TIMING.stagger)
    expect(progressAt(0, 0)).toBe(0)
    expect(progressAt(SIRA_TIMING.close, 0)).toBeCloseTo(1, 5)
    expect(progressAt(SIRA_TIMING.close, 3)).toBeCloseTo(1, 5)
    expect(progressAt(SIRA_TIMING.cycle - 1, 0)).toBeCloseTo(0, 2)
    // later ranks start later and close earlier
    expect(progressAt(300, 3)).toBeLessThan(progressAt(300, 0))
    expect(progressAt(1100, 3)).toBeLessThan(progressAt(1100, 0))
    // the delivered timing still drives the showcase when asked for
    expect(progressAt(1000, 0, SHOWCASE_TIMING)).toBeCloseTo(1, 5)
    expect(progressAt(1999, 0, SHOWCASE_TIMING)).toBeCloseTo(0, 2)
  })

  it("the resting frame is the static logo: full reach, full dots, full centre, touching the box", () => {
    const frame = openFrame(LOGO_GEOMETRY)
    expect(frame.openness).toBe(1)
    expect(frame.centerRadius).toBe(LOGO_GEOMETRY.center)
    expect(frame.arms).toHaveLength(8)
    expect(frame.arms[0]).toMatchObject({ x: 200, y: 37, distance: 163, tipRadius: 37 })
    expect(frame.arms[0].distance + frame.arms[0].tipRadius).toBe(LOGO_GEOMETRY.size / 2)
    expect(frameAt(null)).toEqual(frame)
    expect(frameAt(Number.POSITIVE_INFINITY)).toEqual(frame)
  })

  it("mid-cycle the arms are partly open, the centre breathes and dots only bloom after clearing the centre", () => {
    const early = frameAt(120)
    expect(early.openness).toBeGreaterThan(0)
    expect(early.openness).toBeLessThan(0.2)
    expect(early.arms[0].tipRadius).toBe(0)
    // 375 ms: the four ranks sit symmetrically around half-way (smooth is point-symmetric about 0.5).
    const mid = frameAt(375)
    expect(mid.openness).toBeCloseTo(0.5, 2)
    expect(mid.centerRadius).toBeGreaterThan(LOGO_GEOMETRY.seed)
    expect(mid.centerRadius).toBeLessThan(LOGO_GEOMETRY.center)
    expect(mid.arms[0].tipRadius).toBeCloseTo(LOGO_GEOMETRY.tip, 5)
    // opposite arms are identical at every instant
    for (let i = 0; i < 4; i += 1) expect(mid.arms[i].distance).toBeCloseTo(mid.arms[i + 4].distance, 9)
    const closed = frameAt(SIRA_TIMING.cycle - 1)
    expect(closed.openness).toBeLessThan(0.01)
    expect(closed.centerRadius).toBeCloseTo(LOGO_GEOMETRY.seed, 1)
    // negative times wrap into the cycle instead of exploding
    expect(frameAt(-500).openness).toBeCloseTo(frameAt(SIRA_TIMING.cycle - 500).openness, 9)
    // the frame at the close time is the fully open logo — what ThinkingCore starts from
    expect(frameAt(SIRA_TIMING.close)).toEqual(openFrame())
  })

  it("the showcase geometry is the delivered canvas design", () => {
    expect(SHOWCASE_GEOMETRY).toEqual({ size: 720, reach: 186, center: 40, seed: 32, tip: 29, stroke: 13 })
    expect(openFrame(SHOWCASE_GEOMETRY).arms[0].distance).toBe(186)
  })

  it("small renders get the optical weight bump", () => {
    expect(logoGeometryFor(20)).toBe(LOGO_GEOMETRY_SMALL)
    expect(logoGeometryFor(32)).toBe(LOGO_GEOMETRY_SMALL)
    expect(logoGeometryFor(40)).toBe(LOGO_GEOMETRY)
    expect(logoGeometryFor("100%")).toBe(LOGO_GEOMETRY)
    expect(logoGeometryFor(400, "small")).toBe(LOGO_GEOMETRY_SMALL)
    expect(logoGeometryFor(16, "display")).toBe(LOGO_GEOMETRY)
    expect(LOGO_GEOMETRY_SMALL.stroke).toBeGreaterThan(LOGO_GEOMETRY.stroke)
  })

  it("siraMarkSvg renders eight arms, eight dots and the centre in one ink", () => {
    const svg = siraMarkSvg({ title: "SiraGPT" })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="SiraGPT">')).toBe(true)
    expect(svg.match(/<line /g)).toHaveLength(8)
    expect(svg.match(/<circle /g)).toHaveLength(9)
    expect(svg).toContain('stroke="currentColor" stroke-width="17" stroke-linecap="round"')
    expect(svg).toContain('<circle cx="200" cy="200" r="48"/>')
    const decorative = siraMarkSvg({ title: null, color: "#0A0A0A", background: "#fff" })
    expect(decorative).toContain('aria-hidden="true"')
    expect(decorative).toContain('<rect width="400" height="400" fill="#fff"/>')
    expect(decorative).not.toContain("<title>")
  })
})
