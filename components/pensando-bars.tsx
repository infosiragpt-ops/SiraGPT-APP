"use client"

import * as React from "react"
import { SIRA_CELESTE } from "@/lib/thinking-loaders"
import { Dotm3x3_15 } from "@/components/ui/dotm-3x3-15"

export const PENSANDO_BARS_SRC = "/loaders/pensando.svg"

export type PensandoBarsProps = {
  size?: number
  className?: string
}

/**
 * THE only animated in-progress glyph: the 3×3 dot-matrix ripple
 * (shadcn @dotmatrix/dotm-3x3-15), celeste #38BDF8 — never inherited
 * from the theme. The component honors prefers-reduced-motion on its
 * own (static opacity ramp instead of the ripple).
 */
export function PensandoBars({ size = 28, className }: PensandoBarsProps) {
  return (
    <span
      className={className}
      aria-hidden="true"
      data-pensando-bars="1"
      data-loader-src={PENSANDO_BARS_SRC}
      style={{ display: "inline-flex", lineHeight: 0 }}
    >
      <Dotm3x3_15 size={size} color={SIRA_CELESTE} ariaLabel="" />
    </span>
  )
}

export default PensandoBars
