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
      data-claude-asterisk-weight="fine"
      className={["claude-asterisk", active ? "claude-asterisk--active" : "claude-asterisk--idle", className].filter(Boolean).join(" ")}
      style={{ display: "inline-block", flexShrink: 0, color: fill }}
    >
      <g fill="currentColor">
        {arms.map((deg) => (
          <path
            key={deg}
            transform={`rotate(${deg} 20 20)`}
            // one arm, Claude weight: slim rounded blade, gentle taper to the hub
            d="M20 2.4c1.05 0 1.9.85 1.9 1.9l-.65 12.9c-.05.7-.6 1.25-1.25 1.25s-1.2-.55-1.25-1.25L18.1 4.3c0-1.05.85-1.9 1.9-1.9z"
          />
        ))}
        <circle cx="20" cy="20" r="2.1" />
      </g>
    </svg>
  )
}

export default ClaudeAsterisk
