import React from "react"
import ExcelJS from "exceljs"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SpreadsheetPreview, WorkbookGrid } from "@/components/viewers/spreadsheet-preview"

async function realWorkbookBytes() {
  const workbook = new ExcelJS.Workbook()
  const data = workbook.addWorksheet("Respuestas")
  data.addRow(["ID", ...Array.from({ length: 20 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`), "Proporción", "Total"])
  for (let id = 1; id <= 125; id++) {
    data.addRow(id === 11 ? [] : [id, ...Array(20).fill(3), 0.125, { formula: `SUM(B${id + 1}:U${id + 1})`, result: 60 }])
  }
  data.getCell("U1").font = { name: "Arial", bold: true, color: { argb: "FF17365D" }, size: 12 }
  data.getCell("U1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFCCE8FF" } }
  data.getCell("U1").alignment = { horizontal: "center", wrapText: true }
  data.getCell("U1").border = { bottom: { style: "medium", color: { argb: "FF336699" } } }
  data.getCell("V2").numFmt = "0.0%"
  data.getColumn(21).width = 18
  const summary = workbook.addWorksheet("Resumen")
  summary.mergeCells("A1:C2")
  summary.getCell("A1").value = "Resumen de participantes"
  summary.getCell("A3").value = "Completos"
  summary.getCell("B3").value = 124
  summary.getCell("A5").value = "Fin"
  workbook.addWorksheet("Oculta", { state: "hidden" }).getCell("A1").value = "No visible"
  const bytes = await workbook.xlsx.writeBuffer()
  return Uint8Array.from(bytes).buffer
}

describe("native spreadsheet preview", () => {
  it("reads actual XLSX bytes, shows all 23 columns, cached formulas and original cell formatting", async () => {
    render(<SpreadsheetPreview buffer={await realWorkbookBytes()} />)
    const table = await screen.findByRole("table", { name: "Hoja Respuestas" })
    expect(within(table).getAllByRole("columnheader")).toHaveLength(24)
    expect(within(table).getByRole("cell", { name: "A1: ID" })).toBeInTheDocument()
    const p20 = within(table).getByRole("cell", { name: "U1: P20" })
    expect(p20).toHaveStyle({ color: "rgb(23, 54, 93)", backgroundColor: "rgb(204, 232, 255)", fontWeight: "700", textAlign: "center", whiteSpace: "pre-wrap", borderBottom: "2px solid rgb(51, 102, 153)" })
    expect(within(table).getByRole("cell", { name: "V2: 12.5%" })).toBeInTheDocument()
    const total = within(table).getByRole("cell", { name: "W2: 60" })
    expect(total).toHaveTextContent("60")
    fireEvent.click(total)
    expect(screen.getByLabelText("Contenido de la celda")).toHaveTextContent("W2")
    expect(screen.getByLabelText("Contenido de la celda")).toHaveTextContent("=SUM(B2:U2)")
    expect(screen.getByText("126 filas · 23 columnas")).toBeInTheDocument()
    expect(within(table).getByRole("cell", { name: /^A12:\s*$/ })).toBeEmptyDOMElement()
  })

  it("paginates beyond row 100 and switches visible worksheets while preserving merged and blank rows", async () => {
    render(<SpreadsheetPreview buffer={await realWorkbookBytes()} />)
    let table = await screen.findByRole("table", { name: "Hoja Respuestas" })
    expect(within(table).getAllByRole("row")).toHaveLength(101)
    expect(screen.getByRole("button", { name: "Filas anteriores" })).toBeDisabled()
    expect(within(table).queryByRole("cell", { name: "A101: 100" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Filas siguientes" }))
    table = screen.getByRole("table", { name: "Hoja Respuestas" })
    expect(within(table).getByRole("cell", { name: "A101: 100" })).toBeInTheDocument()
    expect(within(table).getByRole("cell", { name: "U126: 3" })).toBeInTheDocument()
    expect(screen.getByText("101–126")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Filas siguientes" })).toBeDisabled()
    fireEvent.click(screen.getByRole("tab", { name: "Resumen" }))
    expect(screen.getByRole("tab", { name: "Resumen" })).toHaveAttribute("aria-selected", "true")
    table = screen.getByRole("table", { name: "Hoja Resumen" })
    const merged = within(table).getByRole("cell", { name: "A1: Resumen de participantes" })
    expect(merged).toHaveAttribute("rowspan", "2")
    expect(merged).toHaveAttribute("colspan", "3")
    expect(within(table).queryByRole("cell", { name: "B1: Resumen de participantes" })).toBeNull()
    expect(within(table).getByRole("cell", { name: /^A4:\s*$/ })).toBeEmptyDOMElement()
    expect(screen.queryByRole("tab", { name: "Oculta" })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Respuestas" }))
    expect(screen.getByText("1–100")).toBeInTheDocument()
    expect(screen.getByLabelText("Contenido de la celda")).toHaveTextContent("A1")
  })

  it("focuses cells for keyboard users and exposes the cached formula without executing it", () => {
    const workbook = new ExcelJS.Workbook()
    const data = workbook.addWorksheet("Fórmulas")
    data.getCell("A1").value = { formula: 'HYPERLINK("https://example.invalid", "No abrir")', result: "No abrir" }
    render(<WorkbookGrid workbook={workbook} />)
    const cell = screen.getByRole("cell", { name: "A1: No abrir" })
    fireEvent.focus(cell)
    expect(cell).toHaveAttribute("tabindex", "0")
    expect(screen.getByLabelText("Contenido de la celda")).toHaveTextContent('=HYPERLINK("https://example.invalid", "No abrir")')
    expect(screen.queryByRole("link")).toBeNull()
  })
})
