"use client"

import * as React from "react"
import { CLAUDE_THINK_ACCENT } from "@/lib/thinking-loaders"

export type ThinkingCoreTone = "default" | "error"

export type ThinkingCoreProps = React.SVGAttributes<SVGSVGElement> & {
  size?: number
  /** Animated (thinking) or static (done); reduced motion is handled in CSS. */
  active?: boolean
  /** `error` paints the whole atom in the destructive red (the only colour a thinking surface ever shows). */
  tone?: ThinkingCoreTone
  color?: string
  className?: string
  title?: string
}

/**
 * ThinkingCore — the «Pensando» glyph: three dots orbiting, nothing else.
 * The orbits follow the brand atom (`components/brand/atom-mark.tsx`): three
 * ellipses rotated −90° / 30° / 150° with one electron each. Neither the
 * orbit rings (Luis, 2026-10-02: «solo quiero los puntitos sin las líneas»)
 * nor the nucleus (Luis, 2026-10-05: «el puntito del medio no, solo los 3
 * puntitos dando vueltas») are drawn. While active the three electrons travel
 * their invisible orbits, each starting at a different point so they are
 * never aligned. Idle renders the three dots at the apex of their orbits.
 *
 * Monochrome (Luis, 2026-10-03): the dots take `currentColor`
 * (`--think-accent`, the foreground ink). The ONLY colour is
 * `tone="error"`: when the system fails, the dots turn the destructive red.
 * Electrons move with SMIL `animateMotion` along the exact orbit path
 * (constant speed) at every size (12 px rail → 48 px).
 *
 * Reduced motion lives in `app/globals.css` under the historical
 * `.claude-asterisk` classes: with `prefers-reduced-motion` the moving
 * electrons are hidden and the static ones shown. The outer `<g>` stays
 * attribute-free — CSS targets inner classes, never attributes.
 */

const CX = 12
const CY = 12
const ORBIT_RX = 10
/** 62/170 of the artwork, at rx 10. */
const ORBIT_RY = 3.65
const ORBIT_PATH = `M${CX + ORBIT_RX} ${CY}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CX - ORBIT_RX} ${CY}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CX + ORBIT_RX} ${CY}`

const ELECTRONS = [
  { key: "a", angle: -90, dur: "2.6s", begin: "0s" },
  { key: "b", angle: 30, dur: "3.1s", begin: "-1.1s" },
  { key: "c", angle: 150, dur: "3.6s", begin: "-2.3s" },
] as const

const ERROR_TINT = "hsl(var(--destructive))"

export function ThinkingCore({ size = 20, active = true, tone = "default", color, className, title, style, ...rest }: ThinkingCoreProps) {
  const failed = tone === "error"
  const tint = failed ? ERROR_TINT : color || `var(--think-accent, ${CLAUDE_THINK_ACCENT})`
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-thinking-core={active ? "active" : "idle"}
      data-thinking-tone={tone}
      data-brand-geometry="atom"
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
      <g>
        {ELECTRONS.map(({ key, angle, dur, begin }) => (
          <g key={key} className={`thinking-core__orbit thinking-core__orbit--${key}`} transform={`rotate(${angle} ${CX} ${CY})`}>
            <g className={`thinking-core__electron thinking-core__electron--${key}`}>
              {active ? (
                <circle className="thinking-core__electron-live" r="1.7" fill="currentColor">
                  <animateMotion path={ORBIT_PATH} dur={dur} begin={begin} repeatCount="indefinite" />
                </circle>
              ) : null}
              <circle className="thinking-core__electron-still" cx={CX + ORBIT_RX} cy={CY} r="1.7" fill="currentColor" />
            </g>
          </g>
        ))}
      </g>
    </svg>
  )
}

export default ThinkingCore
