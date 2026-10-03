"use client"

import * as React from "react"
import { ThinkingCore } from "@/components/brand/thinking-core"
import type { ThinkingCoreTone } from "@/components/brand/thinking-core"

export type ClaudeAsteriskProps = {
  size?: number
  /** Animated (thinking) or static (done / reduced motion handled in CSS). */
  active?: boolean
  /** `error` paints the atom in the destructive red (the only colour on a thinking surface). */
  tone?: ThinkingCoreTone
  color?: string
  className?: string
  title?: string
}

/**
 * The SiraGPT "thinking" glyph. Historically the eight-arm asterisk, then
 * the four-leaf clover (PR #887); since the ThinkingCore change it is the
 * neural core (`components/brand/thinking-core.tsx`) — the clover stays the
 * brand logo everywhere else (sidebar, auth, PWA).
 *
 * This is a thin wrapper that keeps the historical name, the
 * `data-claude-asterisk` attributes and the `.claude-asterisk` CSS classes,
 * so `pensando-bars`, `trace-rail`, `agent-trace` and every source-contract
 * test keep working unchanged.
 */
export function ClaudeAsterisk({ size = 20, active = true, tone = "default", color, className, title }: ClaudeAsteriskProps) {
  return (
    <ThinkingCore
      size={size}
      active={active}
      tone={tone}
      color={color}
      className={className}
      title={title}
      data-claude-asterisk={active ? "active" : "idle"}
      data-claude-asterisk-weight="fine"
      data-brand="thinking-core"
    />
  )
}

export default ClaudeAsterisk
