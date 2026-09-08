"use client"

/**
 * ThinkingIndicator — one glyph for every in-progress process:
 * three bouncing celeste bars (#38BDF8), Luis geometry.
 */

import * as React from "react"

import { PensandoBars } from "@/components/pensando-bars"
import { cn } from "@/lib/utils"

const SIZE_PX = {
  xs: 14,
  sm: 18,
  md: 24,
  lg: 32,
  xl: 48,
} as const

export type ThinkingIndicatorSize = keyof typeof SIZE_PX

export interface ThinkingIndicatorProps {
  size?: ThinkingIndicatorSize
  /** Accessible label announced to assistive tech. */
  label?: string
  /** Tailwind classes — typically margins or alignment. */
  className?: string
}

export function ThinkingIndicator({
  size = "sm",
  label = "Procesando",
  className,
}: ThinkingIndicatorProps) {
  const px = SIZE_PX[size]
  return (
    <span
      role="status"
      aria-label={label}
      data-pensando-bars="1"
      className={cn("inline-flex shrink-0 items-center align-middle", className)}
    >
      <PensandoBars size={px} />
    </span>
  )
}

export default ThinkingIndicator
