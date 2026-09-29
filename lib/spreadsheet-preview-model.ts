import type { Cell, Worksheet } from "exceljs"
import type { CSSProperties } from "react"
import { xlsxCellToText } from "./xlsx-client"

export const SHEET_PAGE_ROWS = 100
export const SHEET_MAX_COLUMNS = 200

export function spreadsheetColumnLabel(index: number): string {
  let label = ""
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label
  }
  return label
}

const THEME_COLORS = ["FFFFFF", "000000", "EEECE1", "1F497D", "4F81BD", "C0504D", "9BBB59", "8064A2", "4BACC6", "F79646"]
function excelColor(color: { argb?: string; theme?: number; tint?: number } | undefined): string | undefined {
  const hex = color?.argb?.slice(-6) || (color?.theme != null ? THEME_COLORS[color.theme] : undefined)
  if (!hex || !/^[a-f\d]{6}$/i.test(hex)) return undefined
  const tint = Math.max(-1, Math.min(1, color?.tint || 0))
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16)
    return Math.round(tint < 0 ? value * (1 + tint) : value + (255 - value) * tint)
  })
  return `rgb(${channels.join(", ")})`
}

/** Display cached results. Never execute workbook formulas or external links. */
export function spreadsheetCellText(cell: Pick<Cell, "value" | "numFmt">): string {
  const raw = cell.value
  const value = raw && typeof raw === "object" && ("formula" in raw || "sharedFormula" in raw) ? raw.result : raw
  if (value instanceof Date) {
    if (!cell.numFmt || cell.numFmt === "General") return value.toISOString().slice(0, 10)
    return new Intl.DateTimeFormat("es-PE", { timeZone: "UTC", ...( /[hs]/i.test(cell.numFmt) ? { hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" }) }).format(value)
  }
  if (typeof value !== "number" || !cell.numFmt || cell.numFmt === "General") return xlsxCellToText(raw)
  const format = cell.numFmt.split(";")[value < 0 ? 1 : 0] || cell.numFmt.split(";")[0]
  const pattern = format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")
  if (!/[0#]/.test(pattern)) return String(value)
  const decimals = pattern.match(/\.([0#]+)/)?.[1] || ""
  const percent = pattern.includes("%")
  const text = new Intl.NumberFormat("es-PE", {
    minimumFractionDigits: Math.min(20, (decimals.match(/0/g) || []).length),
    maximumFractionDigits: Math.min(20, decimals.length),
    useGrouping: pattern.includes(","),
    ...(percent ? { style: "percent" } : {}),
  }).format(value)
  const prefix = format.match(/^\s*"([^"]*)"/)?.[1] || format.match(/([$€£¥])/)?.[1] || ""
  return `${prefix}${prefix && !/\s$/.test(prefix) ? " " : ""}${text}`
}

export function spreadsheetCellStyle(cell: Cell): CSSProperties {
  const font = cell.font || {}
  const alignment = cell.alignment || {}
  const fill = cell.fill
  const style: CSSProperties = {
    color: excelColor(font.color) || "#111111", backgroundColor: "#ffffff", fontFamily: font.name || "Calibri, Arial, sans-serif",
    fontSize: font.size ? `${Math.min(72, Math.max(6, font.size))}pt` : "11pt",
    fontWeight: font.bold ? 700 : 400, fontStyle: font.italic ? "italic" : undefined,
    textDecoration: [font.underline ? "underline" : "", font.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    textAlign: alignment.horizontal === "center" ? "center" : alignment.horizontal === "right" ? "right" : alignment.horizontal === "left" ? "left" : typeof cell.value === "number" ? "right" : undefined,
    verticalAlign: alignment.vertical === "top" ? "top" : alignment.vertical === "middle" ? "middle" : "bottom",
    whiteSpace: alignment.wrapText ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    paddingLeft: alignment.indent ? `${Math.min(10, alignment.indent) * 8 + 6}px` : undefined,
  }
  if (fill?.type === "pattern" && fill.pattern === "solid") style.backgroundColor = excelColor(fill.fgColor)
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const border = cell.border?.[edge]
    if (!border?.style) continue
    const width = /thick|double/.test(border.style) ? 3 : /medium/.test(border.style) ? 2 : 1
    const line = /dash/i.test(border.style) ? "dashed" : /dot/i.test(border.style) ? "dotted" : border.style === "double" ? "double" : "solid"
    const property = `border${edge[0].toUpperCase()}${edge.slice(1)}` as "borderTop"
    style[property] = `${width}px ${line} ${excelColor(border.color) || "#64748b"}`
  }
  return style
}

export function spreadsheetDimensions(sheet: Worksheet) {
  return { rows: Math.max(1, sheet.rowCount), columns: Math.min(SHEET_MAX_COLUMNS, Math.max(1, sheet.columnCount)), totalColumns: sheet.columnCount }
}

export function spreadsheetMergeSpans(sheet: Worksheet, firstRow: number, lastRow: number, maxColumn: number) {
  const spans = new Map<string, { rowSpan: number; colSpan: number }>()
  const covered = new Set<string>()
  for (const range of sheet.model.merges || []) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)
    if (!match) continue
    const columnIndex = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
    const top = Math.max(firstRow, Number(match[2])), bottom = Math.min(lastRow, Number(match[4]))
    const left = columnIndex(match[1]), right = Math.min(maxColumn, columnIndex(match[3]))
    if (top > bottom || left > right) continue
    spans.set(`${top}:${left}`, { rowSpan: bottom - top + 1, colSpan: right - left + 1 })
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) if (r !== top || c !== left) covered.add(`${r}:${c}`)
  }
  return { spans, covered }
}
