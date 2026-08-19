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

import { ThinkingBarsIcon } from "@/components/icons/thinking-bars-icon"
import { cn } from "@/lib/utils"

const SIZE_CLASS = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-9 w-9",
  xl: "h-14 w-14",
} as const

export type ThinkingIndicatorSize = keyof typeof SIZE_CLASS

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
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-flex items-center justify-center"
    >
      <ThinkingBarsIcon className={cn(SIZE_CLASS[size], "shrink-0", className)} />
      <span className="sr-only">{label}</span>
    </span>
  )
}

export default ThinkingIndicator
