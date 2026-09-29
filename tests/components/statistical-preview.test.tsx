import React from "react"
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { StatisticalDataPreview } from "@/components/viewers/statistical-preview"
import type { StatisticalPreview } from "@/lib/tabular-preview"

function page(overrides: Partial<StatisticalPreview> = {}): StatisticalPreview {
  return JSON.parse(JSON.stringify({
    format: "sav", filename: "encuesta.sav", rowCount: 3, rowCountKnown: true, columnCount: 3,
    columns: [
      { name: "ID", label: "Participante", type: "numeric", valueLabels: {}, missingValues: [] },
      { name: "P01", label: "Satisfacción", type: "numeric", valueLabels: { "0": "Sin respuesta", "5": "Muy satisfecho" }, missingValues: [{ lo: 99, hi: 99 }] },
      { name: "GRUPO", label: null, type: "string", valueLabels: {}, missingValues: [] },
    ],
    rows: [[1, 0, "Control"], [2, null, "Intervención"]], offset: 0, limit: 2, hasMore: true,
    truncated: { rows: true, columns: false, values: false }, ...overrides,
  }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe("SPSS statistical preview", () => {
  it("shows numeric zero and missing cases correctly, then exposes labels and variable metadata", async () => {
    const loadPage = vi.fn(async () => page())
    render(<StatisticalDataPreview loadPage={loadPage} />)
    let table = await screen.findByRole("table", { name: "Datos SPSS" })
    expect(screen.getByText("3 casos · 3 variables")).toBeInTheDocument()
    expect(within(table).getByRole("cell", { name: "0" })).toHaveTextContent("0")
    expect(within(table).getByRole("cell", { name: "·" })).toHaveAttribute("title", "Valor perdido")
    expect(within(table).getByRole("columnheader", { name: "P01" })).toHaveAttribute("title", "Satisfacción")
    fireEvent.click(screen.getByRole("checkbox", { name: "Mostrar etiquetas" }))
    expect(within(table).getByRole("cell", { name: "Sin respuesta" })).toBeInTheDocument()
    expect(within(table).getByRole("cell", { name: "·" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("tab", { name: "Variables" }))
    table = screen.getByRole("table", { name: "Variables SPSS" })
    const variableRow = within(table).getByRole("row", { name: /P01 numeric Satisfacción/ })
    expect(variableRow).toHaveTextContent("0 = Sin respuesta")
    expect(variableRow).toHaveTextContent("5 = Muy satisfecho")
    expect(variableRow).toHaveTextContent('[{"lo":99,"hi":99}]')
    expect(screen.getByRole("tab", { name: "Variables" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("button", { name: "Casos siguientes" })).toBeNull()
  })

  it("uses the server page size for navigation and can show POR files with unknown case totals", async () => {
    const loadPage = vi.fn(async (offset: number) => page({
      format: "por", filename: "encuesta.por", rowCount: null, rowCountKnown: false,
      offset, rows: offset === 0 ? [[1, 0, "A"], [2, 5, "B"]] : [[3, 5, "C"]],
      hasMore: offset === 0,
    }))
    render(<StatisticalDataPreview loadPage={loadPage} />)
    await screen.findByRole("table", { name: "Datos SPSS" })
    expect(screen.getByText("Casos · 3 variables")).toBeInTheDocument()
    expect(screen.getByText("Solo lectura · POR")).toBeInTheDocument()
    expect(screen.getByText("1–2")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Casos anteriores" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Casos siguientes" }))
    await screen.findByText("3–3")
    expect(loadPage).toHaveBeenLastCalledWith(2)
    expect(screen.getByRole("button", { name: "Casos siguientes" })).toBeDisabled()
    expect(within(screen.getByRole("table", { name: "Datos SPSS" })).getByRole("rowheader", { name: "3" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Casos anteriores" }))
    await screen.findByText("1–2")
    expect(loadPage).toHaveBeenLastCalledWith(0)
  })

  it("reports bounded columns and text explicitly, and lets a failed read be retried", async () => {
    const loadPage = vi.fn().mockRejectedValueOnce(new Error("No se pudo leer el archivo"))
      .mockResolvedValue(page({ columnCount: 40, truncated: { rows: true, columns: true, values: true } }))
    render(<StatisticalDataPreview loadPage={loadPage} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo leer el archivo")
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await screen.findByRole("table", { name: "Datos SPSS" })
    expect(screen.getByRole("status")).toHaveTextContent("Vista acotada a 3 variables; algunos textos o etiquetas se abrevian")
    expect(screen.getByText("3 casos · 40 variables")).toBeInTheDocument()
    expect(loadPage).toHaveBeenCalledTimes(2)
  })

  it("rejects malformed case rows before rendering and can recover with a valid page", async () => {
    const loadPage = vi.fn().mockResolvedValueOnce({ ...page(), rows: [[1, { unexpected: "value" }, "A"]] }).mockResolvedValue(page())
    render(<StatisticalDataPreview loadPage={loadPage} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("vista de datos válida")
    expect(screen.queryByRole("table")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }))
    await screen.findByRole("table", { name: "Datos SPSS" })
  })

  it("resets pagination for a changed document and ignores a pending read from the previous source", async () => {
    const oldNext = deferred<unknown>()
    const loadOld = vi.fn((offset: number) => offset === 0 ? Promise.resolve(page()) : oldNext.promise)
    const loadNew = vi.fn(async (offset: number) => page({ filename: "nuevo.sav", offset, rowCount: 1, rows: offset === 0 ? [[88, 5, "Nuevo"]] : [], hasMore: false }))
    const { rerender } = render(<StatisticalDataPreview loadPage={loadOld} />)
    await screen.findByRole("table", { name: "Datos SPSS" })
    fireEvent.click(screen.getByRole("button", { name: "Casos siguientes" }))
    await waitFor(() => expect(loadOld).toHaveBeenLastCalledWith(2))
    rerender(<StatisticalDataPreview loadPage={loadNew} />)
    await screen.findByRole("cell", { name: "Nuevo" })
    expect(loadNew).toHaveBeenLastCalledWith(0)
    expect(screen.getByText("1–1 de 1")).toBeInTheDocument()
    await act(async () => oldNext.resolve(page({ offset: 2, rows: [[3, 0, "Anterior"]], hasMore: false })))
    expect(screen.queryByRole("cell", { name: "Anterior" })).toBeNull()
    expect(screen.getByRole("cell", { name: "Nuevo" })).toBeInTheDocument()
  })
})
