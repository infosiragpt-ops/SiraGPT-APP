"use client"

import * as React from "react"

/**
 * Office / PDF file-type glyphs in the Microsoft 365 2026 style: a layered
 * document with rounded corners and depth, brand gradient content ribbons
 * and the letter badge anchored bottom-left. One vector source for every
 * surface (composer chips, message chips, document cards, Documents page,
 * connector rows) — crisp at 16 px and 48 px, no raster PNGs.
 */

import {
  PALETTES,
  officeKindFor,
  officeKindForMime,
  officeKindForName,
  officeKindLabel,
  type OfficeKind,
} from "@/lib/office-file-kind"

export { officeKindFor, officeKindForMime, officeKindForName, officeKindLabel }
export type { OfficeKind }

let gradientSeq = 0

export type OfficeFileIconProps = {
  kind: OfficeKind
  /** Rendered size in px (square). */
  size?: number
  className?: string
  /** Accessible name; omit for decorative use next to the file name. */
  title?: string
}

export function OfficeFileIcon({ kind, size = 32, className, title }: OfficeFileIconProps) {
  const p = PALETTES[kind]
  const id = React.useMemo(() => `ofi-${kind}-${(gradientSeq += 1)}`, [kind])
  const badge = `${id}-badge`
  const ribbon = `${id}-ribbon`
  const page = `${id}-page`
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-office-icon={kind}
      className={className}
      style={{ display: "inline-block", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={page} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={p.pageFrom} />
          <stop offset="1" stopColor={p.pageTo} />
        </linearGradient>
        <linearGradient id={ribbon} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={p.ribbonFrom} />
          <stop offset="1" stopColor={p.ribbonTo} />
        </linearGradient>
        <linearGradient id={badge} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={p.badgeFrom} />
          <stop offset="1" stopColor={p.badgeTo} />
        </linearGradient>
      </defs>
      {/* back sheet: depth */}
      <rect x="10.5" y="3.5" width="19" height="25" rx="3.5" fill={p.ribbonTo} opacity="0.35" />
      {/* page */}
      <rect x="8.5" y="1.5" width="21" height="27" rx="3.5" fill={`url(#${page})`} />
      <path d="M23.5 1.5v4.5a2 2 0 0 0 2 2h4" fill="none" stroke={p.ribbonTo} strokeOpacity="0.45" strokeWidth="1" />
      {/* content ribbons */}
      <rect x="12" y="10" width="14.5" height="3.6" rx="1.8" fill={`url(#${ribbon})`} />
      <rect x="12" y="16" width="14.5" height="3.6" rx="1.8" fill={`url(#${ribbon})`} opacity="0.85" />
      <rect x="12" y="22" width="9.5" height="3.6" rx="1.8" fill={`url(#${ribbon})`} opacity="0.7" />
      {/* badge shadow + badge */}
      <rect x="2.6" y="12.6" width="16" height="16" rx="3.6" fill={p.badgeFrom} opacity="0.22" />
      <rect x="1.5" y="11.5" width="16" height="16" rx="3.6" fill={`url(#${badge})`} />
      <text
        x="9.5"
        y="19.7"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'Segoe UI', Inter, system-ui, -apple-system, sans-serif"
        fontWeight={700}
        fontSize={p.letterSize}
        fill="#fff"
        letterSpacing={kind === "pdf" ? -0.2 : 0}
      >
        {p.letter}
      </text>
    </svg>
  )
}

export default OfficeFileIcon
