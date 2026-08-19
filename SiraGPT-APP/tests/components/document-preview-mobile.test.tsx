import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
