import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ComposerDocumentRow } from "@/components/chat/ComposerInlineDisplays"

afterEach(cleanup)

const ready = {
  name: "COMUNICACIONES.xlsx",
  uploading: false,
  progress: { label: undefined, busy: false, failed: false },
  canPreview: true,
  onOpen: vi.fn(),
  onRemove: vi.fn(),
}

describe("compact composer documents", () => {
  it("opens the named document and removes it through a separate accessible control", () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(<ComposerDocumentRow {...ready} onOpen={onOpen} onRemove={onRemove} />)

    fireEvent.click(screen.getByRole("button", { name: "Abrir COMUNICACIONES.xlsx" }))
    expect(onOpen).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole("button", { name: "Quitar COMUNICACIONES.xlsx" }))
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("keeps an uploading document cancellable without opening partial bytes", () => {
    const onOpen = vi.fn()
    const onRemove = vi.fn()
    render(<ComposerDocumentRow {...ready}
      uploading
      canPreview={false}
      progress={{ label: "Subiendo · 42%", busy: true, failed: false }}
      onOpen={onOpen}
      onRemove={onRemove}
    />)

    const open = screen.getByRole("button", { name: "Abrir COMUNICACIONES.xlsx" })
    expect(open).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(open)
    expect(onOpen).not.toHaveBeenCalled()
    expect(screen.getByText("Subiendo · 42%")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Cancelar subida de COMUNICACIONES.xlsx" }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it("shows the processing phase until ready without duplicating the file name", () => {
    const { rerender } = render(<ComposerDocumentRow {...ready}
      progress={{ label: "Subido · Extrayendo texto", busy: true, failed: false }}
    />)
    expect(screen.getByText("Subido · Extrayendo texto")).toBeVisible()
    expect(screen.getAllByText(ready.name)).toHaveLength(1)
    rerender(<ComposerDocumentRow {...ready} />)
    expect(screen.queryByText("Subido · Extrayendo texto")).not.toBeInTheDocument()
  })

  it("retains a visible failure and retries only the chosen document", () => {
    const onRetry = vi.fn()
    const onOpen = vi.fn()
    render(<ComposerDocumentRow {...ready}
      canPreview={false}
      progress={{ label: "No se pudo procesar el documento", busy: false, failed: true }}
      onRetry={onRetry}
      onOpen={onOpen}
    />)
    expect(screen.getByText("No se pudo procesar el documento")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Reintentar COMUNICACIONES.xlsx" }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps the complete long name available to keyboard and screen-reader users", () => {
    const name = "SALUD Temas de investigación 1 con nombres extensos.xlsx"
    const onKeyDown = vi.fn()
    render(<ComposerDocumentRow {...ready} name={name} onKeyDown={onKeyDown} />)
    const open = screen.getByRole("button", { name: `Abrir ${name}` })
    expect(open).toHaveAttribute("title", name)
    fireEvent.keyDown(open, { key: "ArrowDown", altKey: true })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
