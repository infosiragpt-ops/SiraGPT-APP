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
 * The Claude "thinking" glyph: an eight-arm asterisk with rounded, slightly
 * tapered arms. While `active` it rotates slowly and breathes (CSS classes
 * `claude-asterisk--active`); `prefers-reduced-motion` freezes it. Color
 * defaults to the terracotta think accent (`--think-accent`).
 */
export function ClaudeAsterisk({ size = 20, active = true, color, className, title }: ClaudeAsteriskProps) {
  const fill = color || `var(--think-accent, ${CLAUDE_THINK_ACCENT})`
  const arms = [0, 45, 90, 135, 180, 225, 270, 315]
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-claude-asterisk={active ? "active" : "idle"}
      className={["claude-asterisk", active ? "claude-asterisk--active" : "claude-asterisk--idle", className].filter(Boolean).join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: fill }}
    >
      <g fill="currentColor">
        {arms.map((deg) => (
          <path
            key={deg}
            transform={`rotate(${deg} 20 20)`}
            // one arm: rounded outer tip, gentle taper towards the centre
            d="M20 3.2c1.9 0 3.4 1.5 3.4 3.4l-1.1 10.6c-.1 1.2-1.1 2.1-2.3 2.1s-2.2-.9-2.3-2.1L16.6 6.6c0-1.9 1.5-3.4 3.4-3.4z"
          />
        ))}
        <circle cx="20" cy="20" r="3.1" />
      </g>
    </svg>
  )
}

export default ClaudeAsterisk
