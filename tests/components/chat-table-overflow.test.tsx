import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import * as React from "react"

import { ChatTable } from "@/components/markdown/chat-table"

const hint = "Desplázate horizontalmente para ver todas las columnas."
const cells = (value: string) => <tbody><tr><td>{value}</td></tr></tbody>

afterEach(() => vi.unstubAllGlobals())

describe("ChatTable overflow feedback", () => {
  it("offers a labelled keyboard scroll region only when the table exceeds the available width", () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resize: () => void = () => {}
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    const { unmount } = render(<ChatTable label="Comparación de productos">{cells("Bicicleta")}</ChatTable>)
    const table = screen.getByRole("table")
    const viewport = table.parentElement!
    let width = 320
    Object.defineProperties(viewport, {
      clientWidth: { get: () => width },
      scrollWidth: { get: () => 640 },
    })

    act(resize)
    const region = screen.getByRole("region", { name: "Comparación de productos" })
    expect(region).toHaveAttribute("tabindex", "0")
    expect(region).toHaveAccessibleDescription(hint)
    expect(observe).toHaveBeenCalledWith(viewport)
    expect(observe).toHaveBeenCalledWith(table)

    width = 640
    act(resize)
    expect(screen.queryByText(hint)).not.toBeInTheDocument()
    expect(screen.queryByRole("region")).not.toBeInTheDocument()
    expect(viewport).not.toHaveAttribute("tabindex")
    unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it("remeasures streamed cells even when the viewport did not resize", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const { rerender } = render(<ChatTable>{cells("A")}</ChatTable>)
    const viewport = screen.getByRole("table").parentElement!
    let contentWidth = 320
    Object.defineProperties(viewport, {
      clientWidth: { get: () => 320 },
      scrollWidth: { get: () => contentWidth },
    })
    fireEvent(window, new Event("resize"))
    expect(screen.queryByText(hint)).not.toBeInTheDocument()

    contentWidth = 800
    rerender(<ChatTable>{cells("Contenido que sigue llegando")}</ChatTable>)
    expect(screen.getByRole("region", { name: "Tabla del mensaje" })).toHaveAccessibleDescription(hint)
    expect(screen.getByText("Contenido que sigue llegando")).toBeInTheDocument()
  })
})
