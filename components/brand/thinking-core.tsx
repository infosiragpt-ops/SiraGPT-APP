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
 * ThinkingCore — the «Pensando» glyph: a minimal neural core. A solid centre
 * dot, two thin elliptical orbits tilted ±60° and (while active) one ripple
 * ring that expands and fades. Pure SVG, every stroke and fill on
 * `currentColor`, no gradients or filters, so it stays crisp from 12 px
 * (trace rail) to 24 px and snapshot-stable.
 *
 * Motion lives in `app/globals.css` under the `.claude-asterisk` classes:
 * orbits counter-rotate at different speeds, the core beats (0.85→1.1 every
 * 1.2 s) and the ripple grows r 4→11 every 1.6 s. Idle renders static with
 * no ripple; `prefers-reduced-motion` keeps only a gentle opacity pulse.
 *
 * The outer `<g>` stays attribute-free — the CSS animations target it and
 * its children by class, never by attribute.
 */
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
      className={["claude-asterisk", "thinking-core", active ? "claude-asterisk--active" : "claude-asterisk--idle", className]
        .filter(Boolean)
        .join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: tint, ...style }}
      {...rest}
    >
      <g>
        <g className="thinking-core__orbit thinking-core__orbit--a">
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-60 12 12)" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </g>
        <g className="thinking-core__orbit thinking-core__orbit--b">
          <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </g>
        {active ? <circle className="thinking-core__ripple" cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1" /> : null}
        <circle className="thinking-core__core" cx="12" cy="12" r="2.6" fill="currentColor" />
      </g>
    </svg>
  )
}

export default ThinkingCore
