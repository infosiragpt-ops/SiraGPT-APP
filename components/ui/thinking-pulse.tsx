"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * ThinkingPulse — minimal "thinking" affordance: one quiet breathing dot with
 * a soft expanding halo. Monochrome (currentColor), theme-safe, no chrome.
 *
 * Replaces busier loaders in the thinking / agent-activity streams so the
 * streaming-thought surface stays minimal and professional — the shimmering
 * label carries the message; this dot only signals "alive". Honours
 * prefers-reduced-motion (steady dot, no halo).
 */
export function ThinkingPulse({
  size = 14,
  className,
  ariaLabel = "Pensando",
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  const dot = Math.max(5, Math.round(size * 0.42))
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      className={cn("relative inline-flex shrink-0 items-center justify-center text-current", className)}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="thinking-pulse-halo absolute rounded-full bg-current"
        style={{ width: dot, height: dot }}
      />
      <span
        aria-hidden="true"
        className="thinking-pulse-core rounded-full bg-current"
        style={{ width: dot, height: dot }}
      />
    </span>
  )
}

export default ThinkingPulse
