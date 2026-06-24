"use client"

/**
 * ThinkingIndicator — single source of truth for "we're processing"
 * states across siraGPT. Three vertical bars that bounce in sequence,
 * inheriting the surrounding text color via `currentColor`.
 *
 * Use this anywhere a long-running process needs to communicate "still
 * working" — chat thinking, agent task running, document generation,
 * ZIP export, auth bootstrap, file upload, button-loading state, etc.
 * Sizes are preset so every surface stays consistent; pass `className`
 * for positioning (margins, alignment) but avoid overriding h/w.
 *
 * The SVG itself lives in components/icons/thinking-bars-icon.tsx and
 * is shared with the chat ThinkingPlaceholder so the visual language
 * is identical everywhere.
 */

import * as React from "react"

import { DotmCircular15 } from "@/components/ui/dotm-circular-15"
import { cn } from "@/lib/utils"

// Pixel geometry per preset size. The dot size scales with the overall
// footprint (~0.15x) so the circular dot-matrix reads cleanly from the
// tiny inline button loader (xs) up to the full-page bootstrap (xl).
const SIZE_PX = {
  xs: { size: 12, dotSize: 2 },
  sm: { size: 16, dotSize: 2 },
  md: { size: 24, dotSize: 3 },
  lg: { size: 36, dotSize: 5 },
  xl: { size: 56, dotSize: 8 },
} as const

export type ThinkingIndicatorSize = keyof typeof SIZE_PX

export interface ThinkingIndicatorProps {
  size?: ThinkingIndicatorSize
  /** Accessible label announced to assistive tech. */
  label?: string
  /** Tailwind classes — typically margins or color overrides. */
  className?: string
}

export function ThinkingIndicator({
  size = "sm",
  label = "Procesando",
  className,
}: ThinkingIndicatorProps) {
  const { size: px, dotSize } = SIZE_PX[size]
  // DotmCircular15 already renders a `role="status"` element with the
  // accessible label, so we render it directly — wrapping it in a <span>
  // would nest a <div> inside a <span> (invalid DOM / hydration warning)
  // and duplicate the role. `inline-flex align-middle` keeps it sitting
  // cleanly inline next to button/label text.
  return (
    <DotmCircular15
      size={px}
      dotSize={dotSize}
      ariaLabel={label}
      className={cn("inline-flex shrink-0 align-middle", className)}
    />
  )
}

export default ThinkingIndicator
