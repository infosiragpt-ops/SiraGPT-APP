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

// Browser budgets; read the directory before a ZIP reader allocates entries.
const XLSX_MAX_INPUT = 25 * 1024 * 1024
const XLSX_MAX_EXPANDED = 64 * 1024 * 1024
const XLSX_MAX_PART = 16 * 1024 * 1024
const XLSX_MAX_ENTRIES = 4096
const XLSX_MAX_CELLS = 200_000
function xlsxPreviewError(limit = false) {
  const error = new Error(limit ? "Este libro supera los límites de la vista previa. Descárgalo para abrirlo completo." : "El libro contiene un paquete XLSX inválido. Descárgalo para revisarlo.") as Error & { code: string }
  error.code = limit ? "XLSX_PREVIEW_LIMIT_EXCEEDED" : "XLSX_PREVIEW_INVALID"
  return error
}

/** ExcelJS expands merges/column ranges even when the XML has almost no cells. */
function worksheetPreviewCost(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw xlsxPreviewError()
  const attribute = (tag: string, name: string) => {
    const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')(?=\\s|/|$)`).exec(tag)
    return value ? value[1] ?? value[2] : undefined
  }
  const positiveIndex = (value: string | undefined, maximum: number) => {
    if (!value || !/^[1-9]\d*$/.test(value)) throw xlsxPreviewError()
    const index = Number(value)
    if (!Number.isSafeInteger(index) || index > maximum) throw xlsxPreviewError(true)
    return index
  }
  const coordinate = (value: string | undefined) => {
    const match = value && /^([A-Z]+)([1-9]\d*)$/i.exec(value)
    if (!match) throw xlsxPreviewError()
    if (match[1].length > 3) throw xlsxPreviewError(true)
    const column = [...match[1].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
    if (column > 16_384) throw xlsxPreviewError(true)
    return { column, row: positiveIndex(match[2], 1_048_576) }
  }
  const range = (value: string | undefined) => {
    const points = value?.split(":")
    if (!points || points.length > 2) throw xlsxPreviewError()
    const first = coordinate(points[0]), last = coordinate(points[1] || points[0])
    if (first.row > last.row || first.column > last.column) throw xlsxPreviewError()
    return { first, last, area: (last.row - first.row + 1) * (last.column - first.column + 1) }
  }
  let cells = 0, rows = 0, merges = 0, rowSpan = 0, columnSpan = 0
  const tags = /<(?:[\w.-]+:)?(row|c|col|mergeCell|dimension)(?=[\s/>])([^>]*)>/g
  for (let match = tags.exec(xml); match; match = tags.exec(xml)) {
    const [tag, attributes] = [match[1], match[2]]
    if (tag === "dimension") { range(attribute(attributes, "ref")); continue }
    if (tag === "row") {
      rowSpan = Math.max(rowSpan, positiveIndex(attribute(attributes, "r"), 1_048_576))
      if (++rows > XLSX_MAX_CELLS) throw xlsxPreviewError(true)
    } else if (tag === "col") {
      const min = positiveIndex(attribute(attributes, "min"), 16_384), max = positiveIndex(attribute(attributes, "max"), 16_384)
      if (min > max) throw xlsxPreviewError()
      columnSpan = Math.max(columnSpan, max)
    } else if (tag === "c") {
      const point = coordinate(attribute(attributes, "r"))
      rowSpan = Math.max(rowSpan, point.row); columnSpan = Math.max(columnSpan, point.column)
      if (++cells > XLSX_MAX_CELLS) throw xlsxPreviewError(true)
    } else {
      const merged = range(attribute(attributes, "ref"))
      rowSpan = Math.max(rowSpan, merged.last.row); columnSpan = Math.max(columnSpan, merged.last.column)
      merges += merged.area
      if (merges > XLSX_MAX_CELLS) throw xlsxPreviewError(true)
    }
    if (rowSpan > XLSX_MAX_CELLS) throw xlsxPreviewError(true)
  }
  return { cells: cells + merges, rows, rowSpan, columnSpan }
}

/** Check the actual central records without inflating declared sizes. */
export function assertXlsxPreviewBounds(buffer: ArrayBuffer): Map<string, number> {
  if (buffer.byteLength > XLSX_MAX_INPUT) throw xlsxPreviewError(true)
  if (buffer.byteLength < 22) throw xlsxPreviewError()
  const view = new DataView(buffer), bytes = new Uint8Array(buffer)
  let end = -1, lastSignature = -1
  for (let i = buffer.byteLength - 4; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) !== 0x06054b50) continue
    if (lastSignature < 0) lastSignature = i
    if (i + 22 <= buffer.byteLength && i + 22 + view.getUint16(i + 20, true) === buffer.byteLength) { end = i; break }
  }
  if (end < 0 || lastSignature !== end) throw xlsxPreviewError()
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true)
  if (count > XLSX_MAX_ENTRIES) throw xlsxPreviewError(true)
  if (!count || view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || start + view.getUint32(end + 12, true) !== end) throw xlsxPreviewError()
  const parts = new Map<string, number>(), ranges: Array<[number, number]> = [], decoder = new TextDecoder("utf-8", { fatal: true })
  let cursor = start, total = 0, actualCount = 0
  while (cursor < end) {
    if (++actualCount > XLSX_MAX_ENTRIES) throw xlsxPreviewError(true)
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw xlsxPreviewError()
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true)
    const compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true)
    const nameSize = view.getUint16(cursor + 28, true), extraSize = view.getUint16(cursor + 30, true), commentSize = view.getUint16(cursor + 32, true)
    const next = cursor + 46 + nameSize + extraSize + commentSize, local = view.getUint32(cursor + 42, true)
    if (next > end || !nameSize || view.getUint16(cursor + 34, true) || (flags & 0x2041) || ![0, 8].includes(method) || view.getUint16(cursor + 6, true) >= 45 || compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff) throw xlsxPreviewError()
    const extraEnd = cursor + 46 + nameSize + extraSize
    for (let extra = cursor + 46 + nameSize; extra < extraEnd;) {
      if (extra + 4 > extraEnd || view.getUint16(extra, true) === 1) throw xlsxPreviewError()
      const length = view.getUint16(extra + 2, true)
      if (extra + 4 + length > extraEnd) throw xlsxPreviewError()
      extra += 4 + length
    }
    let name: string
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameSize)) } catch { throw xlsxPreviewError() }
    if (/[\x00-\x1f\\]/.test(name) || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").some((part) => part === ".." || part === ".") || parts.has(name)) throw xlsxPreviewError()
    if (expanded > XLSX_MAX_PART || (total += expanded) > XLSX_MAX_EXPANDED || (expanded > 1024 * 1024 && expanded / Math.max(1, compressed) > 200)) throw xlsxPreviewError(true)
    if ((method === 0 && compressed !== expanded) || local + 30 > start || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) throw xlsxPreviewError()
    const localNameSize = view.getUint16(local + 26, true), contentStart = local + 30 + localNameSize + view.getUint16(local + 28, true)
    if (localNameSize !== nameSize || contentStart + compressed > start || !bytes.subarray(local + 30, local + 30 + localNameSize).every((byte, i) => byte === bytes[cursor + 46 + i]) || (!(flags & 8) && (view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== expanded))) throw xlsxPreviewError()
    ranges.push([local, contentStart + compressed]); parts.set(name, expanded); cursor = next
  }
  if (actualCount !== count || cursor !== end) throw xlsxPreviewError()
  ranges.sort((a, b) => a[0] - b[0])
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) throw xlsxPreviewError()
  return parts
}

async function boundedWorkbookZip(buffer: ArrayBuffer) {
  const declared = assertXlsxPreviewBounds(buffer)
  const mod = await import("jszip"), zip = await (mod.default || mod).loadAsync(buffer)
  if (Object.keys(zip.files).length !== declared.size) throw xlsxPreviewError()
  let total = 0, cells = 0, strings = 0, rows = 0, rowSpan = 0, columnSpan = 0
  for (const [name, size] of declared) {
    const file = zip.files[name]
    if (!file) throw xlsxPreviewError()
    if (file.dir) { if (size) throw xlsxPreviewError(); continue }
    // JSZip's streaming API lets us stop before accumulating a forged size.
    const content = await new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = []
      let actual = 0, failed = false
      // JSZip exposes this streaming API at runtime; its bundled types omit it.
      type ZipStream = { on(event: "data" | "error" | "end", callback: (...args: any[]) => void): ZipStream; pause(): ZipStream; resume(): ZipStream }
      const stream = (file as unknown as { internalStream(type: "uint8array"): ZipStream }).internalStream("uint8array")
      stream.on("data", (chunk: Uint8Array) => {
        if (failed) return
        actual += chunk.byteLength
        if (actual > size || actual > XLSX_MAX_PART || total + actual > XLSX_MAX_EXPANDED) {
          failed = true; chunks.length = 0; stream.pause(); reject(xlsxPreviewError(actual > XLSX_MAX_PART || total + actual > XLSX_MAX_EXPANDED)); return
        }
        chunks.push(chunk)
      }).on("error", () => { chunks.length = 0; if (!failed) reject(xlsxPreviewError()) }).on("end", () => {
        if (failed) return
        if (actual !== size) { reject(xlsxPreviewError()); return }
        const out = new Uint8Array(actual)
        let at = 0
        for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
        resolve(out)
      }).resume()
    })
    total += content.byteLength
    if (/^xl\/(worksheets\/[^/]+|sharedStrings)\.xml$/i.test(name)) {
      const xml = new TextDecoder().decode(content)
      const count = (pattern: RegExp) => { let n = 0; while (pattern.exec(xml)) if (++n > XLSX_MAX_CELLS) throw xlsxPreviewError(true); return n }
      if (name.toLowerCase() === "xl/sharedstrings.xml") strings += count(/<(?:[\w.-]+:)?si(?=[\s>])/g)
      else {
        const cost = worksheetPreviewCost(xml)
        cells += cost.cells; rows += cost.rows; rowSpan += cost.rowSpan; columnSpan += cost.columnSpan
      }
      if ([cells, strings, rows, rowSpan, columnSpan].some(value => value > XLSX_MAX_CELLS)) throw xlsxPreviewError(true)
    }
    // All retry paths receive bounded STORE bytes, never original compression.
    zip.file(name, content, { binary: true, createFolders: false, compression: "STORE" })
  }
  return zip
}

// ExcelJS crashes parsing chart drawings written by openpyxl/other writers
// ("undefined is not an object (evaluating 'r.anchors')"), which broke the
// preview for every workbook the pipeline generates with charts. The preview
// only renders tabular data, so we strip xl/drawings + xl/charts (and the
// <drawing/> references in each sheet) from the zip before handing the bytes
// to ExcelJS. Recovery only uses the archive already checked and bounded above.
async function stripWorkbookDrawings(zip: Awaited<ReturnType<typeof boundedWorkbookZip>>, safeBytes: ArrayBuffer): Promise<ArrayBuffer> {
  // Charts, drawings AND table parts all crash ExcelJS's reader when written
  // by other engines (openpyxl): drawings → "r.anchors", tables → undefined
  // entry in value.tables. The preview only needs cell data.
  const doomed = zip.file(/^xl\/(drawings|charts|tables)\//)
  if (doomed.length === 0) return safeBytes
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
  return zip.generateAsync({ type: "arraybuffer", compression: "STORE" })
}

export async function readXlsxWorkbook(buffer: ArrayBuffer) {
  const bounded = await boundedWorkbookZip(buffer)
  const safeBytes = await bounded.generateAsync({ type: "arraybuffer", compression: "STORE" })
  const ExcelJS = await loadExcelJS()
  const workbook = new ExcelJS.Workbook()
  let bytes = safeBytes
  try {
    bytes = await stripWorkbookDrawings(bounded, safeBytes)
  } catch {
    // Cosmetic sanitization can fail. Safety validation above cannot fall back.
  }
  try {
    await workbook.xlsx.load(bytes)
  } catch (err) {
    if (bytes === safeBytes) throw err
    // Sanitised bytes failed for another reason — try the original once.
    await workbook.xlsx.load(safeBytes)
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
