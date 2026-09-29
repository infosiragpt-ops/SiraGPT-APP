import assert from "node:assert/strict"
import { describe, it } from "node:test"
import ExcelJS from "exceljs"
import { spreadsheetCellStyle, spreadsheetCellText, spreadsheetColumnLabel, spreadsheetDimensions, spreadsheetMergeSpans } from "../lib/spreadsheet-preview-model"

describe("spreadsheet preview model", () => {
  it("keeps every question and empty row after a real 23-column XLSX round trip", async () => {
    const source = new ExcelJS.Workbook()
    const sheet = source.addWorksheet("Respuestas")
    sheet.addRow(["ID", ...Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`), "Proporción", "Total"])
    sheet.addRow([1, ...Array(20).fill(3), 0.125, { formula: "SUM(B2:U2)", result: 60 }])
    sheet.getCell("A4").value = 2
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(await source.xlsx.writeBuffer())
    const result = loaded.getWorksheet("Respuestas")!
    assert.deepEqual(spreadsheetDimensions(result), { rows: 4, columns: 23, totalColumns: 23 })
    assert.equal(spreadsheetCellText(result.getCell("U1")), "P20")
    assert.equal(spreadsheetCellText(result.getCell("U2")), "3")
    assert.equal(spreadsheetCellText(result.getCell("A3")), "")
    assert.equal(spreadsheetCellText(result.getCell("W2")), "60")
    assert.equal(result.getCell("W2").formula, "SUM(B2:U2)")
  })

  it("uses Excel column addresses beyond Z and announces a bounded view without losing total width", () => {
    assert.equal(spreadsheetColumnLabel(1), "A")
    assert.equal(spreadsheetColumnLabel(23), "W")
    assert.equal(spreadsheetColumnLabel(26), "Z")
    assert.equal(spreadsheetColumnLabel(27), "AA")
    assert.equal(spreadsheetColumnLabel(702), "ZZ")
    assert.equal(spreadsheetColumnLabel(703), "AAA")
    const sheet = new ExcelJS.Workbook().addWorksheet("Ancha")
    sheet.getCell("GT205").value = "Última"
    assert.deepEqual(spreadsheetDimensions(sheet), { rows: 205, columns: 200, totalColumns: 202 })
  })

  it("displays cached numeric results with percentage, grouping and currency formats", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Formatos")
    sheet.getCell("A1").value = { formula: "1/8", result: 0.125 }
    sheet.getCell("A1").numFmt = "0.0%"
    assert.equal(spreadsheetCellText(sheet.getCell("A1")), "12.5%")
    sheet.getCell("A2").value = 1234.5
    sheet.getCell("A2").numFmt = '"S/ "#,##0.00'
    assert.equal(spreadsheetCellText(sheet.getCell("A2")), "S/ 1,234.50")
    sheet.getCell("A3").value = -9876.5
    sheet.getCell("A3").numFmt = "#,##0.00;[Red]-#,##0.00"
    assert.equal(spreadsheetCellText(sheet.getCell("A3")), "-9,876.50")
    sheet.getCell("A4").value = new Date("2026-09-29T00:00:00.000Z")
    sheet.getCell("A4").numFmt = "dd/mm/yyyy"
    assert.equal(spreadsheetCellText(sheet.getCell("A4")), "29/09/2026")
    sheet.getCell("A5").value = { richText: [{ text: "Pregunta " }, { text: "20", font: { bold: true } }] }
    assert.equal(spreadsheetCellText(sheet.getCell("A5")), "Pregunta 20")
  })

  it("formats cached results of shared formulas exactly like their master cell", async () => {
    const source = new ExcelJS.Workbook()
    const sheet = source.addWorksheet("Compartidas")
    sheet.getCell("A1").value = { formula: "1/8", result: 0.125 }
    sheet.getCell("A2").value = { sharedFormula: "A1", result: 0.125 }
    sheet.getCell("A1").numFmt = "0.0%"
    sheet.getCell("A2").numFmt = "0.0%"
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(await source.xlsx.writeBuffer())
    const result = loaded.getWorksheet("Compartidas")!
    assert.equal(spreadsheetCellText(result.getCell("A1")), "12.5%")
    assert.equal(spreadsheetCellText(result.getCell("A2")), "12.5%")
  })

  it("preserves font, fill, wrapping, alignment and border styling", () => {
    const cell = new ExcelJS.Workbook().addWorksheet("Estilos").getCell("B2")
    cell.value = "Datos"
    cell.font = { name: "Arial", size: 12, bold: true, italic: true, underline: true, color: { argb: "FF17365D" } }
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFCCE8FF" } }
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true, indent: 1 }
    cell.border = { bottom: { style: "medium", color: { argb: "FF336699" } }, left: { style: "dashed" } }
    const style = spreadsheetCellStyle(cell)
    assert.equal(style.fontFamily, "Arial")
    assert.equal(style.fontSize, "12pt")
    assert.equal(style.fontWeight, 700)
    assert.equal(style.fontStyle, "italic")
    assert.equal(style.textDecoration, "underline")
    assert.equal(style.color, "rgb(23, 54, 93)")
    assert.equal(style.backgroundColor, "rgb(204, 232, 255)")
    assert.equal(style.textAlign, "center")
    assert.equal(style.verticalAlign, "middle")
    assert.equal(style.whiteSpace, "pre-wrap")
    assert.equal(style.paddingLeft, "14px")
    assert.equal(style.borderBottom, "2px solid rgb(51, 102, 153)")
    assert.equal(style.borderLeft, "1px dashed #64748b")
  })

  it("renders merged cells once, including a merge crossing a page boundary", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Combinadas")
    sheet.mergeCells("A1:C2")
    sheet.getCell("A1").value = "Encabezado"
    sheet.mergeCells("B99:D102")
    sheet.getCell("B99").value = "Continúa"
    const first = spreadsheetMergeSpans(sheet, 1, 100, 23)
    assert.deepEqual(first.spans.get("1:1"), { rowSpan: 2, colSpan: 3 })
    assert.equal(first.covered.has("2:3"), true)
    assert.equal(first.covered.has("1:1"), false)
    assert.deepEqual(first.spans.get("99:2"), { rowSpan: 2, colSpan: 3 })
    const second = spreadsheetMergeSpans(sheet, 101, 126, 23)
    assert.deepEqual(second.spans.get("101:2"), { rowSpan: 2, colSpan: 3 })
    assert.equal(second.covered.has("102:4"), true)
    assert.equal(spreadsheetCellText(sheet.getCell("B101")), "Continúa")
  })
})
