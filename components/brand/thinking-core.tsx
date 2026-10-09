"use client"

import * as React from "react"
import { CLAUDE_THINK_ACCENT } from "@/lib/thinking-loaders"
import { frameAt, logoGeometryFor, openFrame, type SiraFrame, type SiraGeometry } from "@/lib/brand/sira-motion"

export type ThinkingCoreTone = "default" | "error"

export type ThinkingCoreProps = React.SVGAttributes<SVGSVGElement> & {
  size?: number
  /** Animated (thinking) or static (done). Reduced motion always renders the static mark. */
  active?: boolean
  /** `error` paints the whole mark in the destructive red (the only colour a thinking surface ever shows). */
  tone?: ThinkingCoreTone
  color?: string
  className?: string
  title?: string
}

/**
 * ThinkingCore — the «Pensando» glyph: the SiraGPT mark in motion.
 *
 * Official brand since 2026-10-09 (Luis): the eight-arm mark
 * (`components/brand/sira-mark.tsx`) and its animation — eight arms open and
 * close in a continuous two-second cycle, in four staggered ranks (opposite
 * arms move together), the dots bloom once they clear the centre and the
 * centre breathes between its seed and its full size. The motion model lives
 * in `lib/brand/sira-motion.ts` (pure, tested); this component only moves
 * SVG attributes on each animation frame, so it is crisp at every size
 * (12 px rail → 48 px) and themes with `currentColor` like every other mark.
 *
 * Idle (`active={false}`) and `prefers-reduced-motion` render the resting
 * open frame — exactly the static logo. The server render is that same
 * frame, so there is no flash before hydration. Frames pause while the tab
 * is hidden or the glyph is out of view.
 *
 * Monochrome (Luis, 2026-10-03): the ink is `currentColor` (`--think-accent`,
 * the foreground). The ONLY colour is `tone="error"`: when the system fails
 * the whole mark turns the destructive red.
 */

const ERROR_TINT = "hsl(var(--destructive))"

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function paint(svg: SVGSVGElement, frame: SiraFrame) {
  const arms = svg.querySelectorAll<SVGLineElement>(".thinking-core__arm")
  const tips = svg.querySelectorAll<SVGCircleElement>(".thinking-core__tip")
  const core = svg.querySelector<SVGCircleElement>(".thinking-core__core")
  frame.arms.forEach((arm, i) => {
    const line = arms[i]
    const tip = tips[i]
    if (line) {
      line.setAttribute("x2", String(round(arm.x)))
      line.setAttribute("y2", String(round(arm.y)))
      // A zero-length arm would still draw its round caps: hide it instead.
      line.setAttribute("visibility", arm.distance > 0 ? "visible" : "hidden")
    }
    if (tip) {
      tip.setAttribute("cx", String(round(arm.x)))
      tip.setAttribute("cy", String(round(arm.y)))
      tip.setAttribute("r", String(round(arm.tipRadius)))
    }
  })
  if (core) core.setAttribute("r", String(round(frame.centerRadius)))
}

export function ThinkingCore({ size = 20, active = true, tone = "default", color, className, title, style, ...rest }: ThinkingCoreProps) {
  const failed = tone === "error"
  const tint = failed ? ERROR_TINT : color || `var(--think-accent, ${CLAUDE_THINK_ACCENT})`
  const geometry: SiraGeometry = React.useMemo(() => logoGeometryFor(size), [size])
  const resting = React.useMemo(() => openFrame(geometry), [geometry])
  const svgRef = React.useRef<SVGSVGElement>(null)

  React.useEffect(() => {
    const svg = svgRef.current
    if (!svg) return undefined
    if (!active) {
      paint(svg, resting)
      return undefined
    }
    const reduced = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null
    if (reduced?.matches) {
      paint(svg, resting)
      return undefined
    }
    let raf = 0
    let anchor: number | null = null
    let inView = true
    let disposed = false
    const tick = (now: number) => {
      raf = 0
      if (disposed || document.hidden || !inView) return
      if (anchor === null) anchor = now
      paint(svg, frameAt(now - anchor, geometry))
      raf = requestAnimationFrame(tick)
    }
    const start = () => {
      if (disposed || raf || document.hidden || !inView) return
      raf = requestAnimationFrame(tick)
    }
    const stop = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    const onReduced = (event: MediaQueryListEvent) => {
      if (!event.matches) return
      stop()
      paint(svg, resting)
    }
    document.addEventListener("visibilitychange", onVisibility)
    reduced?.addEventListener?.("change", onReduced)
    const observer = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
        inView = entries.some((entry) => entry.isIntersecting)
        if (inView) start()
        else stop()
      })
      : null
    observer?.observe(svg)
    start()
    return () => {
      disposed = true
      stop()
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      reduced?.removeEventListener?.("change", onReduced)
      paint(svg, resting)
    }
  }, [active, geometry, resting])

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${geometry.size} ${geometry.size}`}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-thinking-core={active ? "active" : "idle"}
      data-thinking-tone={tone}
      data-brand-geometry="sira"
      className={[
        "claude-asterisk",
        "thinking-core",
        active ? "claude-asterisk--active" : "claude-asterisk--idle",
        failed ? "claude-asterisk--error" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: tint, ...style }}
      {...rest}
    >
      <g className="thinking-core__arms" stroke="currentColor" strokeWidth={geometry.stroke} strokeLinecap="round">
        {resting.arms.map((arm) => (
          <line key={arm.index} className="thinking-core__arm" x1={resting.centre} y1={resting.centre} x2={round(arm.x)} y2={round(arm.y)} />
        ))}
      </g>
      <g className="thinking-core__dots" fill="currentColor">
        {resting.arms.map((arm) => (
          <circle key={arm.index} className="thinking-core__tip" cx={round(arm.x)} cy={round(arm.y)} r={arm.tipRadius} />
        ))}
        <circle className="thinking-core__core" cx={resting.centre} cy={resting.centre} r={resting.centerRadius} />
      </g>
    </svg>
  )
}

export default ThinkingCore
