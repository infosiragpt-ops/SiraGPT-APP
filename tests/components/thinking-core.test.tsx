import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"
import { ThinkingCore } from "@/components/brand/thinking-core"
import { LOGO_GEOMETRY_SMALL, SIRA_TIMING, frameAt, openFrame } from "@/lib/brand/sira-motion"

// Behaviour of the «Pensando» glyph in a browser-like DOM: the animation is
// driven by requestAnimationFrame, which we capture and fire by hand so every
// frame is deterministic. jsdom has no IntersectionObserver or matchMedia, so
// the glyph counts as in view with motion allowed.

type FrameCallback = (now: number) => void

function readArm(svg: SVGSVGElement, index: number) {
  const line = svg.querySelectorAll<SVGLineElement>(".thinking-core__arm")[index]
  const tip = svg.querySelectorAll<SVGCircleElement>(".thinking-core__tip")[index]
  return {
    x2: Number(line.getAttribute("x2")),
    y2: Number(line.getAttribute("y2")),
    display: line.getAttribute("display"),
    visibility: line.getAttribute("visibility"),
    tipRadius: Number(tip.getAttribute("r")),
  }
}

describe("ThinkingCore — frame loop", () => {
  let callbacks: FrameCallback[]
  let hidden: boolean

  beforeEach(() => {
    callbacks = []
    hidden = false
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: FrameCallback) => {
      callbacks.push(cb)
      return callbacks.length
    }))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (document as unknown as { hidden?: boolean }).hidden
  })

  const fire = (now: number) => {
    const pending = callbacks.splice(0)
    act(() => {
      for (const cb of pending) cb(now)
    })
  }

  it("renders the resting logo, continues from it on the first frame (no pop to the closed state) and hides closed arms with display, never visibility", () => {
    const { container } = render(<ThinkingCore size={20} />)
    const svg = container.querySelector("svg") as SVGSVGElement
    const resting = openFrame(LOGO_GEOMETRY_SMALL)
    // Server/initial markup is the open logo.
    expect(readArm(svg, 0)).toMatchObject({ x2: 200, y2: 40, tipRadius: resting.arms[0].tipRadius })
    expect(callbacks).toHaveLength(1)

    // First animated frame: still the open logo (the clock starts at the close time).
    fire(10_000)
    const first = readArm(svg, 0)
    expect(first.x2).toBeCloseTo(resting.arms[0].x, 1)
    expect(first.y2).toBeCloseTo(resting.arms[0].y, 1)
    expect(first.display).toBe("inline")
    expect(first.visibility).toBeNull()

    // Half a second later the arms are closing.
    fire(10_500)
    const closing = readArm(svg, 0)
    const expected = frameAt(SIRA_TIMING.close + 500, LOGO_GEOMETRY_SMALL)
    expect(closing.y2).toBeCloseTo(expected.arms[0].y, 1)
    expect(closing.y2).toBeGreaterThan(resting.arms[0].y)

    // A full cycle after the start the mark is closed: arms are display:none, no visibility attribute.
    fire(10_000 + SIRA_TIMING.cycle - SIRA_TIMING.close)
    const closed = readArm(svg, 0)
    expect(closed.display).toBe("none")
    expect(closed.visibility).toBeNull()
    expect(closed.tipRadius).toBe(0)
    for (const line of Array.from(svg.querySelectorAll(".thinking-core__arm"))) {
      expect(line.getAttribute("visibility")).toBeNull()
    }
  })

  it("pauses while the tab is hidden and resumes from the same phase (no jump)", () => {
    const { container } = render(<ThinkingCore size={20} />)
    const svg = container.querySelector("svg") as SVGSVGElement
    fire(1_000)
    fire(1_300)
    const beforePause = readArm(svg, 2)
    expect(callbacks).toHaveLength(1)

    hidden = true
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    // The pending frame is dropped; nothing is painted while hidden.
    fire(50_000)
    expect(readArm(svg, 2)).toEqual(beforePause)
    expect(callbacks).toHaveLength(0)

    hidden = false
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(callbacks).toHaveLength(1)
    // Resuming much later paints the frame where it paused, not 49 s further.
    fire(50_000)
    const resumed = readArm(svg, 2)
    expect(resumed.x2).toBeCloseTo(beforePause.x2, 1)
    expect(resumed.y2).toBeCloseTo(beforePause.y2, 1)
    // …and keeps moving from there.
    fire(50_200)
    const moved = readArm(svg, 2)
    const expected = frameAt(SIRA_TIMING.close + 300 + 200, LOGO_GEOMETRY_SMALL)
    expect(moved.x2).toBeCloseTo(expected.arms[2].x, 1)
  })

  it("idle and unmount paint the resting logo", () => {
    const { container, rerender, unmount } = render(<ThinkingCore size={20} />)
    const svg = container.querySelector("svg") as SVGSVGElement
    fire(1_000)
    fire(1_400)
    expect(readArm(svg, 0).y2).toBeGreaterThan(40)
    rerender(<ThinkingCore size={20} active={false} />)
    expect(readArm(svg, 0)).toMatchObject({ x2: 200, y2: 40, display: "inline" })
    expect(svg.getAttribute("data-thinking-core")).toBe("idle")
    unmount()
  })
})
