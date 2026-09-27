"use client"

import * as React from "react"
import { CLAUDE_THINK_ACCENT } from "@/lib/thinking-loaders"

export type ClaudeAsteriskProps = {
  size?: number
  /** Animated (thinking) or static (done / reduced motion handled in CSS). */
  active?: boolean
  color?: string
  className?: string
  title?: string
}

/**
 * The SiraGPT "thinking" glyph: the four-leaf clover brand mark, drawn in
 * the think accent (`--think-accent`, clover green). While `active` it
 * rotates slowly and breathes (CSS classes `claude-asterisk--active`);
 * `prefers-reduced-motion` freezes it.
 *
 * The component keeps its historical name (`ClaudeAsterisk`) so every
 * caller and source-contract test keeps working; only the geometry changed
 * from the eight-arm asterisk to the clover.
 */

// One heart-shaped leaf, tip at the origin, axis pointing up (clover.svg geometry).
const LEAF_PATH =
  "M0 0 C -16 -30, -62 -44, -76 -84 C -90 -124, -56 -154, -28 -136 C -12 -126, -5 -112, 0 -100 C 5 -112, 12 -126, 28 -136 C 56 -154, 90 -124, 76 -84 C 62 -44, 16 -30, 0 0 Z"
const STEM_PATH =
  "M -6 12 C -2 70, 4 120, 22 170 C 34 202, 62 216, 82 200 C 92 192, 86 178, 74 182 C 54 190, 44 178, 36 156 C 22 118, 16 70, 12 12 Z"

export function ClaudeAsterisk({ size = 20, active = true, color, className, title }: ClaudeAsteriskProps) {
  const fill = color || `var(--think-accent, ${CLAUDE_THINK_ACCENT})`
  const leaves = [0, 90, 180, 270]
  return (
    <svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-claude-asterisk={active ? "active" : "idle"}
      data-claude-asterisk-weight="fine"
      data-brand="clover"
      className={["claude-asterisk", active ? "claude-asterisk--active" : "claude-asterisk--idle", className].filter(Boolean).join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: fill }}
    >
      {/* Outer <g> carries the CSS breathe animation (it sets `transform`),
          so the geometry offset lives on the inner group. */}
      <g fill="currentColor">
        <g transform="translate(256 244)">
          {leaves.map((deg) => (
            <path key={deg} transform={`rotate(${deg})`} d={LEAF_PATH} />
          ))}
          <path d={STEM_PATH} />
        </g>
      </g>
    </svg>
  )
}

export default ClaudeAsterisk
