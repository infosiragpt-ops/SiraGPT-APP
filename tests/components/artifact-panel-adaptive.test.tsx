import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ArtifactPanel } from "@/components/chat/ArtifactPanel"

const panelMocks = vi.hoisted(() => ({
  close: vi.fn(),
  setView: vi.fn(),
  active: {
    code: "<!doctype html><html><body>Informe</body></html>",
    language: "html",
    title: "Informe",
    view: "preview" as const,
  },
}))

vi.mock("@/lib/artifact-panel-context", () => ({
  useArtifactPanel: () => ({
    active: panelMocks.active,
    close: panelMocks.close,
    setView: panelMocks.setView,
  }),
}))

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}))

function installMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches,
    media: "(max-width: 639px)",
    onchange: null,
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  })))
}

describe("ArtifactPanel adaptive semantics", () => {
  beforeEach(() => {
    panelMocks.close.mockReset()
    panelMocks.setView.mockReset()
    document.body.style.overflow = ""
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    document.body.style.overflow = ""
  })

  it("is an inline region on desktop without locking page scroll", async () => {
    installMatchMedia(false)
    render(<ArtifactPanel />)

    const region = await screen.findByRole("region", { name: "Informe" })
    expect(region).not.toHaveAttribute("aria-modal")
    expect(region).toHaveAttribute("data-presentation", "desktop-split")
    expect(document.body.style.overflow).toBe("")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(panelMocks.close).toHaveBeenCalledOnce()
  })

  it("becomes a focus-trapped modal drawer only on mobile", async () => {
    installMatchMedia(true)
    const opener = document.createElement("button")
    document.body.appendChild(opener)
    opener.focus()

    const view = render(<ArtifactPanel />)
    const dialog = await screen.findByRole("dialog", { name: "Informe" })

    expect(dialog).toHaveAttribute("aria-modal", "true")
    expect(dialog).toHaveAttribute("data-presentation", "mobile-drawer")
    await waitFor(() => expect(document.body.style.overflow).toBe("hidden"))
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    view.unmount()
    expect(document.body.style.overflow).toBe("")
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
