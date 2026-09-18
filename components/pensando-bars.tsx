"use client"

import * as React from "react"
import { CLAUDE_THINK_ACCENT } from "@/lib/thinking-loaders"
import { ClaudeAsterisk } from "@/components/claude-asterisk"

export const PENSANDO_BARS_SRC = "/loaders/pensando.svg"

export type PensandoBarsProps = {
  size?: number
  className?: string
}

/**
 * THE only animated in-progress glyph: the Claude asterisk (eight rounded
 * arms, slow rotation + breathing) in the terracotta think accent #D97757
 * (`--think-accent`), the same glyph for chat, agent loop, documents and
 * images. The name is historical (it replaced the celeste 3×3 dot matrix,
 * which replaced the bouncing bars); every caller keeps working unchanged.
 * Honors prefers-reduced-motion (static glyph).
 */
export function PensandoBars({ size = 20, className }: PensandoBarsProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      data-pensando-bars="1"
      data-loader-src={PENSANDO_BARS_SRC}
      style={{ display: "inline-flex", lineHeight: 0 }}
    >
      <ClaudeAsterisk size={size} active color={`var(--think-accent, ${CLAUDE_THINK_ACCENT})`} />
    </span>
  )
}

export default PensandoBars
