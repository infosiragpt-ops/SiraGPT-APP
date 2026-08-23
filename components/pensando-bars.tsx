"use client"

import * as React from "react"
import { SIRA_CELESTE } from "@/lib/thinking-loaders"
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks"

export const PENSANDO_BARS_SRC = "/loaders/pensando.svg"

const BARS = [
  { x: 20, begin: "0" },
  { x: 30, begin: "0.2s" },
  { x: 40, begin: "0.4s" },
] as const

export type PensandoBarsProps = {
  size?: number
  className?: string
}

/**
 * THE only animated in-progress glyph: three celeste bars, Luis geometry.
 * fill is hardcoded #38BDF8 — never inherited from the theme.
 */
export function PensandoBars({ size = 28, className }: PensandoBarsProps) {
  const reduced = usePrefersReducedMotion()
  return (
    <svg
      version="1.1"
      id="L9"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      x="0px"
      y="0px"
      viewBox="10 40 45 50"
      enableBackground="new 0 0 0 0"
      xmlSpace="preserve"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      data-pensando-bars="1"
      data-loader-src={PENSANDO_BARS_SRC}
    >
      {BARS.map((bar) => (
        <rect key={bar.x} x={bar.x} y={50} width={4} height={10} fill={SIRA_CELESTE}>
          {reduced ? null : (
            <animateTransform
              attributeType="xml"
              attributeName="transform"
              type="translate"
              values="0 0; 0 20; 0 0"
              begin={bar.begin}
              dur="0.6s"
              repeatCount="indefinite"
            />
          )}
        </rect>
      ))}
    </svg>
  )
}

export default PensandoBars
