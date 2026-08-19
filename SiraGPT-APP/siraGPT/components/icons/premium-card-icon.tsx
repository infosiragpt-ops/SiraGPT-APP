import * as React from "react"

/**
 * Premium credit-card glyph — inspired by the Visa Infinite metal card
 * (deep navy surface, gold chip, contactless waves). Used as the
 * "Gestionar plan" / upgrade CTA icon in the header.
 *
 * Filled SVG with brand-like colors rather than stroke-only — this ONE
 * icon is the paid-product signifier, so it intentionally carries more
 * visual weight than the surrounding monochrome icons.
 */
export function PremiumCardIcon({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 16"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {/* Card body — deep navy gradient for depth */}
      <defs>
        <linearGradient id="card-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0A1628" />
          <stop offset="1" stopColor="#132744" />
        </linearGradient>
        <linearGradient id="card-chip" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E6B54A" />
          <stop offset="1" stopColor="#B8863A" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="23" height="15" rx="2.5" fill="url(#card-body)" stroke="#1a2e4a" strokeWidth="0.5" />

      {/* EMV chip — gold, rounded rect with inner lines for realism */}
      <rect x="3" y="5" width="4" height="3" rx="0.5" fill="url(#card-chip)" />
      <path
        d="M3 6h4M3 7h4M5 5v3"
        stroke="#8d6020"
        strokeWidth="0.3"
        strokeLinecap="round"
      />

      {/* Contactless waves — two subtle arcs to the right of the chip */}
      <path
        d="M8.5 5.5a2 2 0 0 1 0 2M9.8 4.8a3.4 3.4 0 0 1 0 3.4"
        stroke="#D4B97E"
        strokeWidth="0.55"
        strokeLinecap="round"
        fill="none"
      />

      {/* Subtle highlight on the top-left for "polished" feel */}
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="5"
        rx="2.5"
        fill="white"
        fillOpacity="0.05"
      />
    </svg>
  )
}

export default PremiumCardIcon
