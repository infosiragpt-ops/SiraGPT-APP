import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CodingPreviewPane } from "@/components/agentes/coding-preview-pane"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { ensureCodexPreviewOrigin } from "@/lib/codex/use-codex-health"

vi.mock("@/lib/codex/api/projects", async () => {
  const actual = await vi.importActual<typeof import("@/lib/codex/api/projects")>(
    "@/lib/codex/api/projects",
  )
  return {
    ...actual,
    projectsCodexApi: {
      ...actual.projectsCodexApi,
      startPreview: vi.fn(),
      previewStatus: vi.fn(),
      stopPreview: vi.fn(),
    },
  }
})

vi.mock("@/lib/codex/use-codex-health", async () => {
  const actual = await vi.importActual<typeof import("@/lib/codex/use-codex-health")>(
    "@/lib/codex/use-codex-health",
  )
  return { ...actual, ensureCodexPreviewOrigin: vi.fn() }
})

describe("CodingPreviewPane", () => {
  beforeEach(() => {
    vi.mocked(ensureCodexPreviewOrigin).mockReset().mockResolvedValue(null)
    vi.mocked(projectsCodexApi.startPreview).mockReset()
    vi.mocked(projectsCodexApi.previewStatus).mockReset()
    vi.mocked(projectsCodexApi.stopPreview).mockReset().mockResolvedValue({ ok: true })
  })

  it("pide abrir un proyecto cuando no hay projectId", () => {
    render(<CodingPreviewPane projectId={null} />)
    expect(screen.getByTestId("agentes-preview-pane")).toHaveTextContent("Abre un proyecto")
  })

  it("arranca y muestra el iframe con la URL del proxy", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/",
      previewUrl: "/api/codex/projects/p1/preview/tok/app/",
      basePath: "/api/codex/projects/p1/preview/tok/app/",
    })
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const iframe = await screen.findByTestId("agentes-preview-iframe")
    expect(iframe).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    expect(vi.mocked(projectsCodexApi.startPreview)).toHaveBeenCalledWith("p1", expect.any(AbortSignal))
  })

  it("muestra error amable ante pool lleno y reintenta", async () => {
    vi.mocked(projectsCodexApi.startPreview)
      .mockRejectedValueOnce(Object.assign(new Error("pool"), { status: 429 }))
      .mockResolvedValueOnce({
        devUrl: "/x/",
        previewUrl: "/x/",
        basePath: "/x/",
      })
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    expect(await screen.findByTestId("agentes-preview-error")).toHaveTextContent("demasiadas vistas previas")
    fireEvent.click(screen.getByTestId("agentes-preview-retry"))
    await screen.findByTestId("agentes-preview-iframe")
  })

  it("Detener llama stopPreview y vuelve a idle", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/x/",
      previewUrl: "/x/",
      basePath: "/x/",
    })
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    await screen.findByTestId("agentes-preview-iframe")
    fireEvent.click(screen.getByTestId("agentes-preview-stop"))
    await waitFor(() => {
      expect(vi.mocked(projectsCodexApi.stopPreview)).toHaveBeenCalledWith("p1")
    })
    expect(screen.getByTestId("agentes-preview-start")).toBeInTheDocument()
  })
})
