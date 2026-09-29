import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getAdminTurnFailures: vi.fn(),
  getAdminTurnFailureStats: vi.fn(),
  exportAdminTurnFailuresCsv: vi.fn(),
  getAdminTurnFailuresRecent: vi.fn(),
  getAdminRequestLogs: vi.fn(),
}))
vi.mock("@/lib/api", () => ({ apiClient: api }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { TurnFailuresPanel } from "@/components/admin/turn-failures/turn-failures-panel"

const failure = {
  id: "al_1",
  createdAt: new Date().toISOString(),
  userId: "u1",
  userEmail: "luis@example.com",
  resourceId: "c1:k1",
  category: "adjunto_perdido",
  categoryLabel: "Adjunto perdido",
  severity: "critical",
  sound: "strong",
  cause: "Imagen no encontrada al responder",
  fingerprint: "adjunto_perdido|imagen no encontrada al responder",
  model: "Grok 4.7",
  route: "generate",
  prompt: "resolver este problema",
  whatUserSaw: "(nada)",
  totalMs: 81770,
  ttfbMs: null,
  chatId: "c1",
  occurrences: 1,
  metadata: {
    openLink: "/agentes/c1",
    stages: [
      { label: "Leyendo el archivo adjunto", tool: "read_file", atMs: 400 },
      { label: "Preparando la respuesta", atMs: 77_000 },
    ],
    notes: [{ kind: "attachment_missing", atMs: 77_100, data: { kind: "image" } }],
    reqIds: ["263c0fd5"],
    browser: "Safari 26.5 · macOS",
  },
}

const stats = {
  serverTime: new Date().toISOString(),
  counts: { lastHour: 1, last24h: 3, last7d: 9 },
  byCategory24h: [{ name: "adjunto_perdido", count: 1, label: "Adjunto perdido" }, { name: "error_visible", count: 2, label: "Error visible" }],
  byModel24h: [{ name: "Grok 4.7", count: 3 }],
  failureRate24h: { failed: 3, total: 40, pct: 7.5 },
  topCauses: {
    "24h": [{
      fingerprint: "error_visible|xai 429",
      cause: "xAI 429",
      category: "error_visible",
      categoryLabel: "Error visible",
      severity: "high",
      count: 2,
      previousCount: 1,
      trendPct: 100,
      isNew: false,
      affectedUsers: 1,
      topModels: [{ model: "Grok 4.7", count: 2 }],
      lastAt: new Date().toISOString(),
      examples: [{ id: "al_1", createdAt: new Date().toISOString(), userEmail: "luis@example.com", prompt: "resolver este problema" }],
    }],
    "7d": [],
  },
}

describe("TurnFailuresPanel", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("lists failed turns with what the user saw, counters and top causes", async () => {
    api.getAdminTurnFailures.mockResolvedValue({ items: [failure], total: 1, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue(stats)
    render(<TurnFailuresPanel />)

    const row = await screen.findByTestId("turn-failure-row")
    expect(within(row).getByText("Adjunto perdido")).toBeTruthy()
    expect(within(row).getByText("Imagen no encontrada al responder")).toBeTruthy()
    expect(within(row).getByText("resolver este problema")).toBeTruthy()
    expect(within(row).getByText("(nada)")).toBeTruthy()
    expect(within(row).getByText("1 min 22 s")).toBeTruthy()

    await waitFor(() => expect(screen.getByText("7.5%")).toBeTruthy())
    expect(screen.getByText("3 de 40 preguntas")).toBeTruthy()
    const causes = screen.getByTestId("turn-failure-causes")
    expect(within(causes).getByText("xAI 429")).toBeTruthy()
    expect(within(causes).getByText("↑ 100%")).toBeTruthy()
    expect(screen.getByTestId("turn-failure-sound-status").textContent).toBe("Sonido de errores: desactivado")
  })

  it("opens the full detail: stages, technical notes and the chat link", async () => {
    api.getAdminTurnFailures.mockResolvedValue({ items: [failure], total: 1, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue(stats)
    // «Registros en vivo» not deployed yet → its button stays hidden.
    api.getAdminRequestLogs.mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }))
    render(<TurnFailuresPanel />)
    fireEvent.click(await screen.findByTestId("turn-failure-row"))
    const detail = await screen.findByTestId("turn-failure-detail")
    const stages = within(detail).getByTestId("turn-failure-stages")
    expect(within(stages).getByText("Leyendo el archivo adjunto")).toBeTruthy()
    expect(within(detail).getByText(/attachment_missing/)).toBeTruthy()
    expect(within(detail).getByText("Abrir chat").closest("a")?.getAttribute("href")).toBe("/agentes/c1")
    expect(within(detail).getByText("Safari 26.5 · macOS")).toBeTruthy()
    await waitFor(() => expect(api.getAdminRequestLogs).toHaveBeenCalledWith("263c0fd5"))
    expect(within(detail).queryByTestId("turn-failure-request-logs")).toBeNull()
  })

  it("shows «Registros de esta petición» when the live-logs endpoint answers", async () => {
    api.getAdminTurnFailures.mockResolvedValue({ items: [failure], total: 1, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue(stats)
    api.getAdminRequestLogs.mockResolvedValue({
      lines: [{ ts: "2026-09-26T21:04:05.123Z", level: "error", msg: "[ai-service] Image file not found" }],
    })
    render(<TurnFailuresPanel />)
    fireEvent.click(await screen.findByTestId("turn-failure-row"))
    const detail = await screen.findByTestId("turn-failure-detail")
    const button = await within(detail).findByTestId("turn-failure-request-logs")
    expect(button.textContent).toContain("Ver 1 registro de 263c0fd5")
    fireEvent.click(button)
    expect(within(detail).getByTestId("turn-failure-request-log-lines").textContent)
      .toContain("21:04:05.123 ERROR  [ai-service] Image file not found")
  })

  it("labels a failed media generation with its subtype and generator", async () => {
    const generationFailure = {
      ...failure,
      id: "al_2",
      category: "herramienta_fallida",
      categoryLabel: "Herramienta fallida",
      cause: "Generación de imagen: rechazada por moderación · xAI",
      metadata: {
        ...failure.metadata,
        subtype: "generacion_imagen",
        generation: { kind: "image", provider: "xai", model: "grok-2-image", reason: "moderacion" },
      },
    }
    api.getAdminTurnFailures.mockResolvedValue({ items: [generationFailure], total: 1, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue(stats)
    api.getAdminRequestLogs.mockRejectedValue(new Error("Not found"))
    render(<TurnFailuresPanel />)
    fireEvent.click(await screen.findByTestId("turn-failure-row"))
    const detail = await screen.findByTestId("turn-failure-detail")
    expect(within(detail).getByText("Generación de imagen")).toBeTruthy()
    expect(within(detail).getByText("xai · grok-2-image")).toBeTruthy()
  })

  it("shows a calm empty state when nothing failed", async () => {
    api.getAdminTurnFailures.mockResolvedValue({ items: [], total: 0, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue({ ...stats, topCauses: { "24h": [], "7d": [] } })
    render(<TurnFailuresPanel />)
    expect(await screen.findByTestId("turn-failures-empty")).toBeTruthy()
  })

  // Luis (2026-09-29): pick exactly the failures to copy, in the chosen format.
  it("selects failures without opening the detail and copies only those; Ctrl+C and the format picker work", async () => {
    const second = { ...failure, id: "al_2", cause: "DeepSeek 500", prompt: "otra pregunta", category: "error_visible", categoryLabel: "Error visible" }
    api.getAdminTurnFailures.mockResolvedValue({ items: [failure, second], total: 2, page: 1, limit: 25 })
    api.getAdminTurnFailureStats.mockResolvedValue(stats)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(<TurnFailuresPanel />)
    await screen.findAllByTestId("turn-failure-row")
    expect(screen.queryByTestId("turn-failures-selection")).toBeNull()
    const boxes = screen.getAllByTestId("turn-failure-select")
    fireEvent.click(boxes[1])
    expect(screen.queryByTestId("turn-failure-detail")).toBeNull()
    expect(screen.getByTestId("turn-failures-selection").textContent).toMatch(/1 fallo seleccionado/)

    fireEvent.click(screen.getByTestId("turn-failures-copy-selected"))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0][0] as string
    expect(text).toMatch(/Error visible: DeepSeek 500/)
    expect(text).toMatch(/Pregunta: otra pregunta/)
    expect(text).not.toMatch(/resolver este problema/)

    fireEvent.keyDown(document, { key: "c", ctrlKey: true })
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByTestId("turn-failures-select-all"))
    expect(screen.getByTestId("turn-failures-selection").textContent).toMatch(/2 fallos seleccionados/)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByTestId("turn-failures-selection")).toBeNull()
  })
})
