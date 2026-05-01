"use client"

type ExcelJSNamespace = {
  Workbook: new () => any
}

let excelJSPromise: Promise<ExcelJSNamespace> | null = null

async function loadExcelJS(): Promise<ExcelJSNamespace> {
  if (!excelJSPromise) {
    excelJSPromise = import("exceljs").then((mod: any) => (mod.default || mod) as ExcelJSNamespace)
  }
  return excelJSPromise
}

export function xlsxCellToText(cell: any): string {
  if (cell == null) return ""
  if (cell instanceof Date) return cell.toISOString()
  if (typeof cell !== "object") return String(cell)
  if (cell.text != null) return String(cell.text)
  if (cell.result != null) return xlsxCellToText(cell.result)
  if (Array.isArray(cell.richText)) return cell.richText.map((part: any) => part?.text || "").join("")
  if (cell.formula) return String(cell.result ?? `=${cell.formula}`)
  return String(cell)
}

export function xlsxRowToValues(row: any, maxColumns = 80): string[] {
  const values = Array.isArray(row?.values) ? row.values.slice(1, maxColumns + 1) : []
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
