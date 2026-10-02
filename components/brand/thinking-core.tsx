"use client"

import * as React from "react"
import { CLAUDE_THINK_ACCENT } from "@/lib/thinking-loaders"

export type ThinkingCoreProps = React.SVGAttributes<SVGSVGElement> & {
  size?: number
  /** Animated (thinking) or static (done); reduced motion is handled in CSS. */
  active?: boolean
  color?: string
  className?: string
  title?: string
}

/**
 * ThinkingCore — the «Pensando» glyph: the SiraGPT atom in motion, dots only.
 * The same geometry as the brand mark (`components/brand/atom-mark.tsx`): a
 * solid nucleus and three elliptical orbits rotated −90° / 30° / 150° with one
 * electron each — but the orbit rings are NOT drawn (Luis, 2026-10-02: «solo
 * quiero los puntitos sin las líneas»). While active, the three electrons
 * travel their invisible orbits — each in its own colour
 * (`--think-electron-a|b|c`) and with a fading trail («estela») behind it —
 * around the nucleus, which beats. Idle renders the static logo
 * (electron at the apex of its orbit, no trail), so a finished turn ends on
 * the brand itself. Luis supplied the animation (canvas «ia-estelas»: «tres
 * puntos de color giran con estela alrededor del punto central») and the
 * atom logo on 2026-10-02.
 *
 * The nucleus takes `currentColor` (`--think-accent`, the foreground ink). Electrons move with SMIL `animateMotion` along the exact
 * orbit path (paced → constant speed); the trail is a dash on a duplicate of
 * the orbit (`pathLength="100"`) whose `stroke-dashoffset` animates in sync,
 * so the tail bends with the ellipse at every size (12 px rail → 48 px).
 * Phases are spread with negative `begin` offsets.
 *
 * The nucleus beat and reduced motion live in `app/globals.css` under the
 * historical `.claude-asterisk` classes: with `prefers-reduced-motion` the
 * moving electrons and trails are hidden and the static electrons shown, the
 * nucleus keeps a soft opacity pulse only. The outer `<g>` stays
 * attribute-free — CSS targets inner classes, never attributes.
 */

const CX = 12
const CY = 12
const ORBIT_RX = 10
/** 62/170 of the artwork, at rx 10. */
const ORBIT_RY = 3.65
const ORBIT_PATH = `M${CX + ORBIT_RX} ${CY}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CX - ORBIT_RX} ${CY}A${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${CX + ORBIT_RX} ${CY}`

/** Trail length as % of the orbit (pathLength 100): long faint + short bright. */
const TRAIL_LONG = 16
const TRAIL_SHORT = 7

const ELECTRONS = [
  { key: "a", angle: -90, dur: "2.6s", begin: "0s" },
  { key: "b", angle: 30, dur: "3.1s", begin: "-1.1s" },
  { key: "c", angle: 150, dur: "3.6s", begin: "-2.3s" },
] as const

function Trail({ length, dur, begin, opacity }: { length: number; dur: string; begin: string; opacity: number }) {
  // The dash ends exactly where the electron is: offset = length − 100·f.
  return (
    <path
      className="thinking-core__trail"
      d={ORBIT_PATH}
      pathLength={100}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeDasharray={`${length} ${100 - length}`}
      strokeDashoffset={length}
      opacity={opacity}
    >
      <animate attributeName="stroke-dashoffset" from={length} to={length - 100} dur={dur} begin={begin} repeatCount="indefinite" />
    </path>
  )
}

export function ThinkingCore({ size = 20, active = true, color, className, title, style, ...rest }: ThinkingCoreProps) {
  const tint = color || `var(--think-accent, ${CLAUDE_THINK_ACCENT})`
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-thinking-core={active ? "active" : "idle"}
      data-brand-geometry="atom"
      className={["claude-asterisk", "thinking-core", active ? "claude-asterisk--active" : "claude-asterisk--idle", className]
        .filter(Boolean)
        .join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: tint, ...style }}
      {...rest}
    >
      <g>
        {ELECTRONS.map(({ key, angle, dur, begin }) => (
          <g key={key} className={`thinking-core__orbit thinking-core__orbit--${key}`} transform={`rotate(${angle} ${CX} ${CY})`}>
            <g
              className={`thinking-core__electron thinking-core__electron--${key}`}
              style={active ? { color: `var(--think-electron-${key}, currentColor)` } : undefined}
            >
              {active ? (
                <>
                  <Trail length={TRAIL_LONG} dur={dur} begin={begin} opacity={0.28} />
                  <Trail length={TRAIL_SHORT} dur={dur} begin={begin} opacity={0.6} />
                  <circle className="thinking-core__electron-live" r="1.7" fill="currentColor">
                    <animateMotion path={ORBIT_PATH} dur={dur} begin={begin} repeatCount="indefinite" />
                  </circle>
                </>
              ) : null}
              <circle className="thinking-core__electron-still" cx={CX + ORBIT_RX} cy={CY} r="1.7" fill="currentColor" />
            </g>
          </g>
        ))}
        <circle className="thinking-core__core" cx="12" cy="12" r="2.6" fill="currentColor" />
      </g>
    </svg>
  )
}

export default ThinkingCore
