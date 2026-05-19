"use client"

// Minimal subset of the ExcelJS Workbook API we actually use. The library has
// extensive typings but we only need this surface — keeping the boundary tight.
type ExcelJSWorksheet = {
  name: string
  addRows(rows: unknown[][]): void
  columns: Array<{ width: number }>
  getRow(n: number): { font: { bold: boolean } }
  // exceljs uses Iterable-like API; consumers may iterate rows/columns dynamically
  eachRow?(callback: (row: unknown, rowNumber: number) => void): void
  rowCount?: number
  columnCount?: number
}

type ExcelJSWorkbook = {
  creator: string
  created: Date
  worksheets: ExcelJSWorksheet[]
  xlsx: {
    load(buffer: ArrayBuffer): Promise<void>
    writeBuffer(): Promise<ArrayBuffer>
  }
  addWorksheet(name: string): ExcelJSWorksheet
}

type ExcelJSNamespace = {
  Workbook: new () => ExcelJSWorkbook
}

let excelJSPromise: Promise<ExcelJSNamespace> | null = null

async function loadExcelJS(): Promise<ExcelJSNamespace> {
  if (!excelJSPromise) {
    excelJSPromise = import("exceljs").then((mod: unknown) => {
      const m = mod as { default?: ExcelJSNamespace } & ExcelJSNamespace
      return (m.default || m) as ExcelJSNamespace
    })
  }
  return excelJSPromise
}

type XlsxCellLike = {
  text?: unknown
  result?: unknown
  formula?: unknown
  richText?: Array<{ text?: unknown }>
}

export function xlsxCellToText(cell: unknown): string {
  if (cell == null) return ""
  if (cell instanceof Date) return cell.toISOString()
  if (typeof cell !== "object") return String(cell)
  const c = cell as XlsxCellLike
  if (c.text != null) return String(c.text)
  if (c.result != null) return xlsxCellToText(c.result)
  if (Array.isArray(c.richText)) return c.richText.map((part) => part?.text == null ? "" : String(part.text)).join("")
  if (c.formula) return String(c.result ?? `=${String(c.formula)}`)
  return String(cell)
}

export function xlsxRowToValues(row: unknown, maxColumns = 80): string[] {
  const r = row as { values?: unknown[] } | null | undefined
  const values = Array.isArray(r?.values) ? r!.values!.slice(1, maxColumns + 1) : []
  return values.map(xlsxCellToText)
}

export async function readXlsxWorkbook(buffer: ArrayBuffer) {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  return workbook
}

export async function createXlsxBlob(rows: unknown[][], sheetName = "Data") {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "SiraGPT"
  workbook.created = new Date()
  const worksheet = workbook.addWorksheet(sheetName)
  worksheet.addRows(rows)
  const widths: number[] = []
  rows.forEach((row) => {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, String(cell ?? "").length)
    })
  })
  worksheet.columns = widths.map((width) => ({ width: Math.min(Math.max(width + 2, 10), 50) }))
  worksheet.getRow(1).font = { bold: true }
  const output = await workbook.xlsx.writeBuffer()
  return new Blob([output], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
}
