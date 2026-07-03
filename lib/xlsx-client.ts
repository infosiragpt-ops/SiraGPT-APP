"use client"

// Minimal subset of the ExcelJS Workbook API we actually use. The library has
// extensive typings but we only need this surface — keeping the boundary tight.
type ExcelJSWorksheet = {
  name: string
  addRows(rows: unknown[][]): void
  columns: Array<{ width: number }>
  getRow(n: number): { font: { bold: boolean } }
  getCell(address: string): { value: unknown }
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
  getWorksheet(nameOrId?: string | number): ExcelJSWorksheet | undefined
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

// ExcelJS crashes parsing chart drawings written by openpyxl/other writers
// ("undefined is not an object (evaluating 'r.anchors')"), which broke the
// preview for every workbook the pipeline generates with charts. The preview
// only renders tabular data, so we strip xl/drawings + xl/charts (and the
// <drawing/> references in each sheet) from the zip before handing the bytes
// to ExcelJS. Fail-open: if sanitising fails we try the original buffer.
async function stripWorkbookDrawings(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const mod = await import("jszip")
  const JSZip = (mod as { default?: unknown }).default || mod
  type ZipEntry = { name: string; async: (t: "string") => Promise<string> }
  type Zip = {
    file: ((re: RegExp) => Array<{ name: string }>) & ((n: string, c: string) => void)
    remove: (n: string) => void
    files: Record<string, ZipEntry>
    generateAsync: (o: { type: "arraybuffer" }) => Promise<ArrayBuffer>
  }
  const zip = (await (JSZip as { loadAsync: (b: ArrayBuffer) => Promise<unknown> }).loadAsync(buffer)) as Zip
  // Charts, drawings AND table parts all crash ExcelJS's reader when written
  // by other engines (openpyxl): drawings → "r.anchors", tables → undefined
  // entry in value.tables. The preview only needs cell data.
  const doomed = zip.file(/^xl\/(drawings|charts|tables)\//)
  if (doomed.length === 0) return buffer
  for (const entry of doomed) zip.remove(entry.name)
  const sheetNames = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  for (const name of sheetNames) {
    const xml = await zip.files[name].async("string")
    let cleaned = xml.replace(/<drawing [^>]*\/>/g, "")
    cleaned = cleaned.replace(/<tableParts[\s\S]*?<\/tableParts>/g, "").replace(/<tableParts[^>]*\/>/g, "")
    if (cleaned !== xml) zip.file(name, cleaned)
  }
  const relNames = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/_rels\/.*\.rels$/.test(n))
  for (const name of relNames) {
    const xml = await zip.files[name].async("string")
    if (/drawing|table/i.test(xml)) {
      zip.file(name, xml.replace(/<Relationship [^>]*(drawings|tables)[^>]*\/>/gi, ""))
    }
  }
  if (zip.files["[Content_Types].xml"]) {
    const ct = await zip.files["[Content_Types].xml"].async("string")
    zip.file("[Content_Types].xml", ct.replace(/<Override [^>]*(drawing|chart|table)[^>]*\/>/gi, ""))
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

export async function readXlsxWorkbook(buffer: ArrayBuffer) {
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  let bytes = buffer
  try {
    bytes = await stripWorkbookDrawings(buffer)
  } catch {
    // fall back to the raw buffer below
  }
  try {
    await workbook.xlsx.load(bytes)
  } catch (err) {
    if (bytes === buffer) throw err
    // Sanitised bytes failed for another reason — try the original once.
    await workbook.xlsx.load(buffer)
  }
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
