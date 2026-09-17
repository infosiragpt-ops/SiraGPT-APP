import * as React from "react"

import { SIRA_CELESTE } from "@/lib/thinking-loaders"

/** 3×3 dot grid centers on a 36×36 viewBox, with ring = Manhattan distance. */
const DOTS: Array<{ cx: number; cy: number; ring: 0 | 1 | 2 }> = [
  { cx: 6, cy: 6, ring: 2 },
  { cx: 18, cy: 6, ring: 1 },
  { cx: 30, cy: 6, ring: 2 },
  { cx: 6, cy: 18, ring: 1 },
  { cx: 18, cy: 18, ring: 0 },
  { cx: 30, cy: 18, ring: 1 },
  { cx: 6, cy: 30, ring: 2 },
  { cx: 18, cy: 30, ring: 1 },
  { cx: 30, cy: 30, ring: 2 },
]

const RING_BEGIN = ["0s", "0.15s", "0.3s"] as const

/**
 * Pensando — 3×3 dot-matrix ripple (SMIL), hardcoded celeste #38BDF8.
 * Mirrors the interactive Dotm3x3_15 component for static/SVG contexts.
 */
export function ThinkingBarsIcon({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 36 36"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-pensando-bars="1"
      {...props}
    >
      {DOTS.map((dot) => (
        <circle key={`${dot.cx}-${dot.cy}`} cx={dot.cx} cy={dot.cy} r={3.4} fill={SIRA_CELESTE}>
          <animate
            attributeName="opacity"
            values="0.22;1;0.22"
            begin={RING_BEGIN[dot.ring]}
            dur="0.9s"
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </svg>
  )
}

export default ThinkingBarsIcon
