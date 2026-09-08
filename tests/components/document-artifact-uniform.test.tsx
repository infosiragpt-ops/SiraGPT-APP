import * as React from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DocArtifactDisplay } from "@/components/doc/doc-artifact-display"
import { AgenticStepsRenderer } from "@/components/agentic-steps"
import { initialAgentState, type AgentTaskState } from "@/lib/agent-task-service"
import { toast } from "sonner"

// Component/protocol checks with a stubbed download transport. These are not
// document-editing, provider, production, or browser E2E acceptance tests.
const download = vi.hoisted(() => vi.fn())
vi.mock("@/lib/utils", async (original) => ({ ...await original<typeof import("@/lib/utils")>(), downloadUrlAsFile: download }))

function state(format: string, filename: string): AgentTaskState {
  return { ...initialAgentState, steps: [], done: true, artifacts: [{ id: "edited-file", filename,
    format, mime: "application/octet-stream", sizeBytes: 2048, downloadUrl: "/api/agent/artifact/edited-file",
    sourceFileId: "original-file", validation: { passed: true } }] }
}
beforeEach(() => { vi.clearAllMocks(); download.mockResolvedValue(undefined) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

describe("uniform document artifact cards", () => {
  it.each(["docx", "xlsx", "pptx", "pdf"])("keeps the same Office type icon and compact controls for original and edited %s", (format) => {
    const filename = `Informe.${format}`
    render(<>
      <DocArtifactDisplay files={[{ type: "doc", format, filename, url: "/api/agent/artifact/original", size: 2048 }]} onDocumentPreview={() => {}} />
      <AgenticStepsRenderer state={state(format, `Informe editado.${format}`)} onDocumentPreview={() => {}} />
    </>)
    const first = screen.getByTestId("generated-document-card")
    const edited = screen.getByTestId("agent-artifact-card")
    const firstIcon = within(first).getByRole("img")
    const editedIcon = within(edited).getByRole("img")
    expect(firstIcon.getAttribute("src")).toBe(editedIcon.getAttribute("src"))
    expect(firstIcon).toHaveAttribute("width", "40")
    expect(editedIcon).toHaveAttribute("height", "40")
    for (const card of [first, edited]) {
      for (const button of within(card).getAllByRole("button")) {
        expect(button).toHaveClass("h-9", "w-9")
        expect(button).toHaveAttribute("title")
        expect(button).toHaveAccessibleName()
        expect(button).not.toHaveTextContent(/Descargar|Vista previa/)
        expect(button.querySelector("svg")).toHaveClass("h-[18px]", "w-[18px]")
      }
    }
    expect(within(edited).getByText("Validado")).toBeTruthy()
    expect(within(edited).getByRole("button", { name: `Historial de versiones: Informe editado.${format}` })).toBeTruthy()
  })
  it("preserves original preview/download URLs, names and metadata", async () => {
    const preview = vi.fn()
    const successToast = vi.spyOn(toast, "success")
    localStorage.setItem("auth-token", "synthetic-component-test-token")
    render(<DocArtifactDisplay files={[{ type: "doc", format: "pptx", filename: "Informe original.pptx",
      title: "Informe anual", explanation: "Generado y verificado por el agente", url: "/api/agent/artifact/original", size: 2048 }]} onDocumentPreview={preview} />)
    fireEvent.click(screen.getByRole("button", { name: "Ver documento: Informe original.pptx" }))
    expect(preview).toHaveBeenCalledExactlyOnceWith({ url: "/api/agent/artifact/original", downloadUrl: "/api/agent/artifact/original", filename: "Informe original.pptx" })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Descargar documento: Informe original.pptx" })) })
    expect(download).toHaveBeenCalledWith("/api/agent/artifact/original", "Informe original.pptx", {
      credentials: "include", headers: { Authorization: "Bearer synthetic-component-test-token" },
    })
    expect(successToast).not.toHaveBeenCalled()
    expect(screen.getByText("Informe anual")).toBeTruthy()
    expect(screen.getByText("Generado y verificado por el agente")).toBeTruthy()
    expect(screen.getByText("2.0 KB")).toBeTruthy()
  })
  it("preserves inline preview collapse when there is no side-panel callback", () => {
    render(<DocArtifactDisplay files={[{ type: "doc", format: "docx", filename: "Informe.docx", htmlPreview: "<p>Texto</p>" }]} />)
    const hide = screen.getByRole("button", { name: "Ocultar documento: Informe.docx" })
    expect(hide).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(hide)
    expect(screen.getByRole("button", { name: "Ver documento: Informe.docx" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByTestId("generated-document-card").querySelector("iframe")).toBeNull()
    expect(screen.getByRole("button", { name: "Descargar documento: Informe.docx" })).toBeDisabled()
  })
  it("retains loading/disabled download state and prevents duplicate downloads", async () => {
    let resolve!: () => void
    download.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    render(<DocArtifactDisplay files={[{ type: "doc", format: "pdf", filename: "Informe.pdf", url: "/api/agent/artifact/original" }]} onDocumentPreview={() => {}} />)
    const button = screen.getByRole("button", { name: "Descargar documento: Informe.pdf" })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
    fireEvent.click(button)
    expect(download).toHaveBeenCalledOnce()
    await act(async () => { resolve() })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute("aria-busy", "false")
  })
  it("keyboard use of an edited card action cannot bubble into the card preview", () => {
    const preview = vi.fn()
    render(<AgenticStepsRenderer state={state("pptx", "Informe editado.pptx")} onDocumentPreview={preview} />)
    fireEvent.keyDown(screen.getByRole("button", { name: "Descargar documento: Informe editado.pptx" }), { key: "Enter" })
    expect(preview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Ver documento: Informe editado.pptx" }))
    expect(preview).toHaveBeenCalledOnce()
    expect(preview.mock.calls[0][0]).toMatchObject({ filename: "Informe editado.pptx" })
  })
  it("keeps actionable errors when a download fails", async () => {
    const errorToast = vi.spyOn(toast, "error")
    vi.spyOn(console, "error").mockImplementation(() => {})
    download.mockRejectedValue(new Error("synthetic download failure"))
    render(<DocArtifactDisplay files={[{ type: "doc", format: "pdf", filename: "Informe.pdf", url: "/api/agent/artifact/original" }]} />)
    const button = screen.getByRole("button", { name: "Descargar documento: Informe.pdf" })
    await act(async () => { fireEvent.click(button) })
    expect(errorToast).toHaveBeenCalledWith("No se pudo descargar el documento")
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute("aria-busy", "false")
  })
})
