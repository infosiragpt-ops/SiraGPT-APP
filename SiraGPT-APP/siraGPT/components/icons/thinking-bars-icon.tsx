import * as React from "react"

/**
 * Thinking — three SMIL-animated bars bouncing in sequence.
 *
 * `currentColor` so it inherits from the parent (matches text/icon hue
 * in light/dark). Self-contained SVG animation — no React state, no
 * setInterval, zero re-render cost.
 */
export function ThinkingBarsIcon({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      version="1.1"
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
      {...props}
    >
      <rect x="20" y="50" width="4" height="10" fill="currentColor">
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
      <rect x="30" y="50" width="4" height="10" fill="currentColor">
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
      <rect x="40" y="50" width="4" height="10" fill="currentColor">
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
