import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  afterEach(() => { vi.restoreAllMocks() })
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
      previewStatus: { project: "p1", ready: true, running: true },
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
        devUrl: "/api/codex/projects/p1/preview/tok/app/",
        previewUrl: "/api/codex/projects/p1/preview/tok/app/",
        basePath: "/api/codex/projects/p1/preview/tok/app/",
        previewStatus: { project: "p1", ready: true, running: true },
      })
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    expect(await screen.findByTestId("agentes-preview-error")).toHaveTextContent("demasiadas vistas previas")
    fireEvent.click(screen.getByTestId("agentes-preview-retry"))
    await screen.findByTestId("agentes-preview-iframe")
  })

  it("Detener llama stopPreview y vuelve a idle", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/",
      previewUrl: "/api/codex/projects/p1/preview/tok/app/",
      basePath: "/api/codex/projects/p1/preview/tok/app/",
      previewStatus: { project: "p1", ready: true, running: true },
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

  it("hot-restart: subir fileVersion en ready recarga el iframe sin reiniciar el server", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/",
      previewUrl: "/api/codex/projects/p1/preview/tok/app/",
      basePath: "/api/codex/projects/p1/preview/tok/app/",
      previewStatus: { project: "p1", ready: true, running: true },
    })
    const { rerender } = render(<CodingPreviewPane projectId="p1" fileVersion={0} />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const first = await screen.findByTestId("agentes-preview-iframe")
    expect(first).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    rerender(<CodingPreviewPane projectId="p1" fileVersion={1} />)
    await waitFor(() => {
      expect(screen.getByTestId("agentes-preview-iframe")).not.toBe(first)
    })
    expect(screen.getByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    expect(vi.mocked(projectsCodexApi.startPreview)).toHaveBeenCalledTimes(1)
  })

  it("hot-restart: subir fileVersion antes de ready no arranca solo; el arranque posterior es normal", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/",
      previewUrl: "/api/codex/projects/p1/preview/tok/app/",
      basePath: "/api/codex/projects/p1/preview/tok/app/",
      previewStatus: { project: "p1", ready: true, running: true },
    })
    const { rerender } = render(<CodingPreviewPane projectId="p1" fileVersion={0} />)
    rerender(<CodingPreviewPane projectId="p1" fileVersion={1} />)
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
    expect(vi.mocked(projectsCodexApi.startPreview)).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    const iframe = await screen.findByTestId("agentes-preview-iframe")
    expect(iframe).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    expect(vi.mocked(projectsCodexApi.startPreview)).toHaveBeenCalledTimes(1)
  })
  it("recovers a ready cloud app without another start and keeps it running after closing", async () => {
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({
      project: "p1", ready: true, running: true, basePath: "/api/codex/projects/p1/preview/tok/app/",
    })
    const { unmount } = render(<CodingPreviewPane projectId="p1" />)
    expect(await screen.findByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/api/codex/projects/p1/preview/tok/app/")
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
    unmount()
    expect(projectsCodexApi.stopPreview).not.toHaveBeenCalled()
  })

  it("does not show a guessed URL without ready state", async () => {
    vi.mocked(projectsCodexApi.startPreview).mockResolvedValue({
      devUrl: "/api/codex/projects/p1/preview/tok/app/", basePath: "/api/codex/projects/p1/preview/tok/app/",
      previewStatus: { project: "p1", ready: false, running: true },
    })
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    await screen.findByTestId("agentes-preview-error")
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
  })

  it("ignores an earlier project recovery that resolves after switching projects", async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(projectsCodexApi.previewStatus).mockReturnValueOnce(new Promise(done => { resolve = done }))
      .mockResolvedValueOnce({ project: "p2", ready: true, running: true, basePath: "/api/codex/projects/p2/preview/tok/app/" })
    const { rerender } = render(<CodingPreviewPane projectId="p1" />)
    rerender(<CodingPreviewPane projectId="p2" />)
    expect(await screen.findByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/api/codex/projects/p2/preview/tok/app/")
    await act(async () => resolve({ project: "p1", ready: true, running: true, basePath: "/api/codex/projects/p1/preview/tok/app/" }))
    expect(screen.getByTestId("agentes-preview-iframe")).toHaveAttribute("src", "/api/codex/projects/p2/preview/tok/app/")
  })

  it("Cancel never renders a late start result", async () => {
    let resolve!: (value: any) => void
    vi.mocked(projectsCodexApi.startPreview).mockReturnValue(new Promise(done => { resolve = done }))
    render(<CodingPreviewPane projectId="p1" />)
    fireEvent.click(screen.getByTestId("agentes-preview-start"))
    await waitFor(() => expect(projectsCodexApi.startPreview).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    await act(async () => resolve({ devUrl: "/api/codex/projects/p1/preview/tok/app/", basePath: "/api/codex/projects/p1/preview/tok/app/", previewStatus: { project: "p1", ready: true, running: true } }))
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
    expect(projectsCodexApi.stopPreview).toHaveBeenCalledWith("p1")
  })

  it("heartbeat replaces a renewed owned preview URL without restarting or stealing the pane", async () => {
    const ticks: Array<() => void> = []
    const realInterval = window.setInterval.bind(window)
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000) { ticks.push(callback as () => void); return 999999 }
      return realInterval(callback, delay, ...args)
    })
    const status = { project: "p1", ready: true, running: true, basePath: "/api/codex/projects/p1/preview/tok/app/" }
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue(status)
    render(<CodingPreviewPane projectId="p1" />)
    const iframe = await screen.findByTestId("agentes-preview-iframe")
    const renewed = "/api/codex/projects/p1/preview/renewed-token/app/"
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ ...status, basePath: renewed })
    await act(async () => { ticks[0]() })
    await waitFor(() => expect(iframe).toHaveAttribute("src", renewed))
    expect(screen.getByTestId("agentes-preview-iframe")).toBe(iframe)
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
    expect(projectsCodexApi.stopPreview).not.toHaveBeenCalled()
  })

  it("distinguishes an expired preview link from a stopped server on heartbeat", async () => {
    const ticks: Array<() => void> = []
    const realInterval = window.setInterval.bind(window)
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000) { ticks.push(callback as () => void); return 999999 }
      return realInterval(callback, delay, ...args)
    })
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ project: "p1", ready: true, running: true, basePath: "/api/codex/projects/p1/preview/tok/app/" })
    render(<CodingPreviewPane projectId="p1" />)
    await screen.findByTestId("agentes-preview-iframe")
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ project: "p1", ready: false, running: true, basePath: null, previewExpired: true })
    await act(async () => { ticks[0]() })
    await screen.findByText(/El enlace de vista previa caducó/)
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
    expect(screen.queryByText("El servidor de vista previa se detuvo.")).toBeNull()
    expect(projectsCodexApi.stopPreview).not.toHaveBeenCalled()
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
  })

  it("explains an expired link during read-only recovery", async () => {
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ project: "p1", ready: false, running: true, basePath: null, previewExpired: true })
    render(<CodingPreviewPane projectId="p1" />)
    await screen.findByText(/El enlace de vista previa caducó/)
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
  })

  it("ignores a pending heartbeat renewal after Stop", async () => {
    const ticks: Array<() => void> = []
    const realInterval = window.setInterval.bind(window)
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000) { ticks.push(callback as () => void); return 999999 }
      return realInterval(callback, delay, ...args)
    })
    const status = { project: "p1", ready: true, running: true, basePath: "/api/codex/projects/p1/preview/tok/app/" }
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue(status)
    render(<CodingPreviewPane projectId="p1" />)
    await screen.findByTestId("agentes-preview-iframe")
    let resolve!: (value: unknown) => void
    vi.mocked(projectsCodexApi.previewStatus).mockReturnValueOnce(new Promise(done => { resolve = done }))
    await act(async () => { ticks[0]() })
    fireEvent.click(screen.getByTestId("agentes-preview-stop"))
    await act(async () => resolve({ ...status, basePath: "/api/codex/projects/p1/preview/renewed-token/app/" }))
    expect(screen.queryByTestId("agentes-preview-iframe")).toBeNull()
    expect(projectsCodexApi.stopPreview).toHaveBeenCalledWith("p1")
  })

})
