import * as React from "react"

import { SIRA_CELESTE } from "@/lib/thinking-loaders"

/**
 * Pensando — three SMIL bars, Luis geometry, hardcoded celeste #38BDF8.
 */
export function ThinkingBarsIcon({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
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
      className={className}
      aria-hidden="true"
      focusable="false"
      data-pensando-bars="1"
      {...props}
    >
      <rect x="20" y="50" width="4" height="10" fill={SIRA_CELESTE}>
        <animateTransform
          attributeType="xml"
          attributeName="transform"
          type="translate"
          values="0 0; 0 20; 0 0"
          begin="0"
          dur="0.6s"
          repeatCount="indefinite"
        />
      </rect>
      <rect x="30" y="50" width="4" height="10" fill={SIRA_CELESTE}>
        <animateTransform
          attributeType="xml"
          attributeName="transform"
          type="translate"
          values="0 0; 0 20; 0 0"
          begin="0.2s"
          dur="0.6s"
          repeatCount="indefinite"
        />
      </rect>
      <rect x="40" y="50" width="4" height="10" fill={SIRA_CELESTE}>
        <animateTransform
          attributeType="xml"
          attributeName="transform"
          type="translate"
          values="0 0; 0 20; 0 0"
          begin="0.4s"
          dur="0.6s"
          repeatCount="indefinite"
        />
      </rect>
    </svg>
  )
}

export default ThinkingBarsIcon
