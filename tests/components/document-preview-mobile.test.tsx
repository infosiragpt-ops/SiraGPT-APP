import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DocumentPreview } from "@/components/document-preview"

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}))

vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(),
}))

function installMatchMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query.includes("879") ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: () => true,
  })))
}

describe("DocumentPreview mobile overlay", () => {
  beforeEach(() => {
    document.body.style.overflow = ""
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.style.overflow = ""
  })

  it("stays an inline split region on wide screens", async () => {
    installMatchMedia(false)
    render(<DocumentPreview url="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>" onClose={vi.fn()} />)

    const region = await screen.findByTestId("document-preview-shell")
    expect(region).toHaveAttribute("data-presentation", "desktop-split")
    expect(region).toHaveAttribute("role", "region")
    expect(region).not.toHaveAttribute("aria-modal")
    expect(document.body.style.overflow).toBe("")
    const toolbar = await screen.findByTestId("document-preview-toolbar")
    expect(screen.getByTestId("document-preview-header")).toContainElement(toolbar)
    expect(within(toolbar).getByRole("button", { name: "Página anterior" })).toBeDisabled()
    expect(within(toolbar).getByRole("button", { name: "Página siguiente" })).toBeDisabled()
    expect(screen.getAllByRole("button", { name: "Página anterior" })).toHaveLength(1)
    fireEvent.click(within(toolbar).getByRole("button", { name: "Acercar documento" }))
    expect(within(toolbar).getByRole("button", { name: "Nivel de zoom" })).toHaveTextContent("110%")
  })

  it("renders text files in the code viewer with copy and zoom but no page navigation", async () => {
    installMatchMedia(false)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("isSecureContext", true)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(
      <DocumentPreview
        url={{ url: "data:text/plain;charset=utf-8,linea%20uno%0Alinea%20dos", filename: "transcripciones-completas.txt" }}
        onClose={vi.fn()}
      />,
    )

    const viewer = await screen.findByTestId("document-preview-text")
    expect(viewer).toHaveTextContent("linea uno")
    expect(viewer).toHaveTextContent("2 líneas")
    const toolbar = screen.getByTestId("document-preview-toolbar")
    expect(within(toolbar).queryByRole("button", { name: "Página anterior" })).toBeNull()
    expect(within(toolbar).getByRole("button", { name: "Nivel de zoom" })).toHaveTextContent("100%")

    fireEvent.click(within(viewer).getByRole("button", { name: "Copiar todo el texto" }))
    await within(viewer).findByRole("button", { name: "Texto copiado" })
    expect(writeText).toHaveBeenCalledWith("linea uno\nlinea dos")
    expect(screen.getByTestId("ppt-btn-copy")).toBeInTheDocument()
  })

  it("portals a full-screen dialog on compact screens and locks scroll", async () => {
    installMatchMedia(true)
    const onClose = vi.fn()
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()

    render(<DocumentPreview url="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'></svg>" onClose={onClose} />)

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveAttribute("data-presentation", "mobile-overlay")
    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(screen.getByRole("button", { name: "Cerrar previsualización" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Más opciones del documento" })).toBeTruthy()
    expect(document.body.style.overflow).toBe("hidden")
    const toolbar = await screen.findByTestId("document-preview-toolbar")
    expect(screen.getByTestId("document-preview-header")).toContainElement(toolbar)
    expect(within(toolbar).getByRole("button", { name: "Página siguiente" })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
