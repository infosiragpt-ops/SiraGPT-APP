import assert from "node:assert/strict"
import { describe, it } from "node:test"
import ExcelJS from "exceljs"
import JSZip from "jszip"
import { assertXlsxPreviewBounds, readXlsxWorkbook } from "../lib/xlsx-client"

function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return Uint8Array.from(bytes).buffer }
async function archive(parts: Record<string, string>, compression: "DEFLATE" | "STORE" = "DEFLATE") {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(parts)) zip.file(name, content, { createFolders: false })
  return zip.generateAsync({ type: "arraybuffer", compression })
}
function centralEntry(bytes: ArrayBuffer, name: string) {
  const view = new DataView(bytes), decoder = new TextDecoder()
  const end = bytes.byteLength - 22
  let cursor = view.getUint32(end + 16, true)
  while (cursor < end) {
    const size = view.getUint16(cursor + 28, true)
    const entry = decoder.decode(new Uint8Array(bytes, cursor + 46, size))
    if (entry === name) return { view, central: cursor, local: view.getUint32(cursor + 42, true) }
    cursor += 46 + size + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true)
  }
  throw new Error(`Missing test ZIP entry ${name}`)
}
const limitError = (error: unknown) => (error as { code?: string })?.code === "XLSX_PREVIEW_LIMIT_EXCEEDED"
const invalidError = (error: unknown) => (error as { code?: string })?.code === "XLSX_PREVIEW_INVALID"

describe("bounded native XLSX reader", () => {
  it("reads a real bounded workbook and preserves cells, formulas, format and merged structure", async () => {
    const source = new ExcelJS.Workbook()
    const sheet = source.addWorksheet("Datos")
    sheet.getCell("A1").value = "ID"
    sheet.getCell("U1").value = "P20"
    sheet.getCell("A2").value = 0
    sheet.getCell("B2").value = { formula: "1/8", result: 0.125 }
    sheet.getCell("B2").numFmt = "0.0%"
    sheet.mergeCells("A4:C4")
    sheet.getCell("A4").value = "Resumen"
    const bytes = arrayBuffer(await source.xlsx.writeBuffer() as unknown as Uint8Array)
    assert.ok(assertXlsxPreviewBounds(bytes).has("xl/worksheets/sheet1.xml"))
    const output = await readXlsxWorkbook(bytes)
    const result = output.getWorksheet("Datos")! as unknown as ExcelJS.Worksheet
    assert.equal(result.getCell("U1").value, "P20")
    assert.equal(result.getCell("A2").value, 0)
    assert.equal(result.getCell("B2").formula, "1/8")
    assert.equal(result.getCell("B2").numFmt, "0.0%")
    assert.equal(result.getCell("C4").value, "Resumen")
  })

  it("rejects compressed input above the browser byte cap without parsing it", () => {
    assert.throws(() => assertXlsxPreviewBounds(new ArrayBuffer(25 * 1024 * 1024 + 1)), limitError)
  })

  it("rejects declared oversized parts and extreme expansion before inflation", async () => {
    const oversized = await archive({ "xl/worksheets/sheet1.xml": "small" })
    const large = centralEntry(oversized, "xl/worksheets/sheet1.xml")
    large.view.setUint32(large.central + 24, 17 * 1024 * 1024, true)
    large.view.setUint32(large.local + 22, 17 * 1024 * 1024, true)
    assert.throws(() => assertXlsxPreviewBounds(oversized), limitError)
    const ratio = await archive({ "xl/worksheets/sheet1.xml": "A".repeat(2 * 1024 * 1024) })
    assert.throws(() => assertXlsxPreviewBounds(ratio), limitError)
  })

  it("checks actual directory entries rather than trusting a forged EOCD count", async () => {
    const bytes = await archive({ "a.xml": "a", "b.xml": "b" })
    const view = new DataView(bytes), end = bytes.byteLength - 22
    view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true)
    assert.throws(() => assertXlsxPreviewBounds(bytes), invalidError)
    const tooMany = await archive(Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`p${i}.xml`, ""])), "STORE")
    assert.throws(() => assertXlsxPreviewBounds(tooMany), limitError)
  })

  it("rejects invalid, encrypted, ZIP64, multidisk and mismatched local packages", async () => {
    assert.throws(() => assertXlsxPreviewBounds(new ArrayBuffer(10)), invalidError)
    for (const mutate of [
      ({ view, central }: ReturnType<typeof centralEntry>) => view.setUint16(central + 8, 1, true),
      ({ view, central }: ReturnType<typeof centralEntry>) => view.setUint16(central + 6, 45, true),
      ({ view, central }: ReturnType<typeof centralEntry>) => view.setUint16(central + 34, 1, true),
      ({ view, local }: ReturnType<typeof centralEntry>) => view.setUint32(local + 22, 123, true),
      ({ view, central }: ReturnType<typeof centralEntry>) => view.setUint16(central + 10, 99, true),
    ]) {
      const bytes = await archive({ "sheet.xml": "data" })
      mutate(centralEntry(bytes, "sheet.xml"))
      assert.throws(() => assertXlsxPreviewBounds(bytes), invalidError)
    }
    const traversal = await archive({ "../sheet.xml": "data" })
    assert.throws(() => assertXlsxPreviewBounds(traversal), invalidError)
  })

  it("stops a stream whose actual expansion exceeds a forged declared size, with no raw fallback", async () => {
    const bytes = await archive({ "xl/worksheets/sheet1.xml": "A".repeat(65_536) })
    const entry = centralEntry(bytes, "xl/worksheets/sheet1.xml")
    entry.view.setUint32(entry.central + 24, 100, true)
    entry.view.setUint32(entry.local + 22, 100, true)
    assert.doesNotThrow(() => assertXlsxPreviewBounds(bytes))
    await assert.rejects(readXlsxWorkbook(bytes), invalidError)
  })

  it("bounds actual cells before ExcelJS allocates them, including STORE archives without high compression", async () => {
    const bytes = await archive({ "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${'<c r="A1"></c>'.repeat(200_001)}</sheetData></worksheet>` }, "STORE")
    assert.doesNotThrow(() => assertXlsxPreviewBounds(bytes))
    await assert.rejects(readXlsxWorkbook(bytes), limitError)
  })

  it("rejects sparse out-of-range rows/columns and enormous merges before ExcelJS expands them", async () => {
    for (const content of [
      '<row r="4294967295"><c r="A4294967295" /></row>',
      '<row r="200001"><c r="A200001" /></row>',
      '<row r="1"><c r="XFE1" /></row>',
      '<col min="1" max="4294967295" />',
      '<mergeCell ref="A1:XFD1048576" />',
      '<dimension ref="A1:XFE1" />',
    ]) {
      const bytes = await archive({ "xl/worksheets/sheet1.xml": `<worksheet>${content}</worksheet>` })
      assert.doesNotThrow(() => assertXlsxPreviewBounds(bytes))
      await assert.rejects(readXlsxWorkbook(bytes), limitError)
    }
  })

  it("bounds aggregate merge expansion and sheet metadata instead of only explicit cells", async () => {
    const cases: Record<string, string>[] = [
      { "xl/worksheets/sheet1.xml": '<worksheet><mergeCells><mergeCell ref="A1:ZZ200" /><mergeCell ref="A201:ZZ400" /></mergeCells></worksheet>' },
      { "xl/worksheets/sheet1.xml": '<worksheet><row r="150000"><c r="A150000" /></row></worksheet>', "xl/worksheets/sheet2.xml": '<worksheet><row r="150000"><c r="A150000" /></row></worksheet>' },
    ]
    for (const parts of cases) {
      const bytes = await archive(parts)
      await assert.rejects(readXlsxWorkbook(bytes), limitError)
    }
  })

  it("rejects malformed or entity-encoded references rather than bypassing the allocation bounds", async () => {
    for (const content of ['<row r="0" />', '<c r="A&#49;" />', '<mergeCell ref="Z9:A1" />', '<col min="4" max="1" />']) {
      const bytes = await archive({ "xl/worksheets/sheet1.xml": `<worksheet>${content}</worksheet>` })
      await assert.rejects(readXlsxWorkbook(bytes), invalidError)
    }
  })
})
