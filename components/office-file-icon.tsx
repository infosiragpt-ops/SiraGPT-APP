"use client"

import * as React from "react"

/**
 * Office / PDF file-type glyphs in the Microsoft 365 2026 style: a layered
 * document with rounded corners and depth, brand gradient content ribbons
 * and the letter badge anchored bottom-left. One vector source for every
 * surface (composer chips, message chips, document cards, Documents page,
 * connector rows) — crisp at 16 px and 48 px, no raster PNGs.
 */

export type OfficeKind = "word" | "excel" | "powerpoint" | "pdf"

type Palette = {
  label: string
  badgeFrom: string
  badgeTo: string
  ribbonFrom: string
  ribbonTo: string
  pageFrom: string
  pageTo: string
  letter: string
  letterSize: number
}

const PALETTES: Record<OfficeKind, Palette> = {
  word: {
    label: "Word",
    badgeFrom: "#0F4FB5", badgeTo: "#2B7CD3",
    ribbonFrom: "#2B7CD3", ribbonTo: "#41A5EE",
    pageFrom: "#F4F8FF", pageTo: "#D6E6FB",
    letter: "W", letterSize: 10.5,
  },
  excel: {
    label: "Excel",
    badgeFrom: "#0C6B39", badgeTo: "#21A366",
    ribbonFrom: "#21A366", ribbonTo: "#33C481",
    pageFrom: "#F2FBF5", pageTo: "#D3F1DF",
    letter: "X", letterSize: 10.5,
  },
  powerpoint: {
    label: "PowerPoint",
    badgeFrom: "#B7371A", badgeTo: "#ED6C47",
    ribbonFrom: "#ED6C47", ribbonTo: "#FF8F6B",
    pageFrom: "#FFF6F2", pageTo: "#FBDCD0",
    letter: "P", letterSize: 10.5,
  },
  pdf: {
    label: "PDF",
    badgeFrom: "#A5221B", badgeTo: "#E4392E",
    ribbonFrom: "#E4392E", ribbonTo: "#FF6B5A",
    pageFrom: "#FFF5F4", pageTo: "#FBD8D5",
    letter: "PDF", letterSize: 5.6,
  },
}

const EXTENSION_KIND: Record<string, OfficeKind> = {
  doc: "word", docx: "word", dot: "word", dotx: "word", odt: "word", rtf: "word",
  xls: "excel", xlsx: "excel", xlsm: "excel", csv: "excel", ods: "excel", tsv: "excel",
  ppt: "powerpoint", pptx: "powerpoint", pps: "powerpoint", ppsx: "powerpoint", odp: "powerpoint",
  pdf: "pdf",
}

const MIME_KIND: Array<[RegExp, OfficeKind]> = [
  [/wordprocessingml|msword|opendocument\.text|\/rtf$/i, "word"],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv|tab-separated/i, "excel"],
  [/presentationml|ms-powerpoint|opendocument\.presentation/i, "powerpoint"],
  [/application\/pdf/i, "pdf"],
]

/** File-type from a name/extension/format token ("informe.docx", "xlsx", "PDF"). */
export function officeKindForName(name: unknown): OfficeKind | null {
  const raw = String(name ?? "").trim().toLowerCase()
  if (!raw) return null
  const token = raw.includes(".") ? raw.split(".").pop() || "" : raw
  return EXTENSION_KIND[token] ?? null
}

/** File-type from a MIME type, for attachments whose name lost its extension. */
export function officeKindForMime(mime: unknown): OfficeKind | null {
  const raw = String(mime ?? "").trim()
  if (!raw) return null
  for (const [re, kind] of MIME_KIND) if (re.test(raw)) return kind
  return null
}

export function officeKindFor(file: { name?: unknown; filename?: unknown; format?: unknown; mimeType?: unknown; type?: unknown } | null | undefined): OfficeKind | null {
  if (!file) return null
  return officeKindForName(file.name) || officeKindForName(file.filename) || officeKindForName(file.format)
    || officeKindForMime(file.mimeType) || officeKindForMime(file.type)
}

export function officeKindLabel(kind: OfficeKind): string {
  return PALETTES[kind].label
}

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
