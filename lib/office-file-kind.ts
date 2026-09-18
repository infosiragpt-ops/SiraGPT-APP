/**
 * Office / PDF file-type detection (pure, no JSX) shared by the vector icon
 * component and by tests. Palettes live here too so the glyph and any
 * non-React consumer (e.g. e-mail templates) agree on brand colours.
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

export const PALETTES: Record<OfficeKind, Palette> = {
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
