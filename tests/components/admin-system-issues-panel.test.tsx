import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getAdminSystemIssues: vi.fn(),
  getAdminSystemIssueStats: vi.fn(),
  getAdminSystemIssue: vi.fn(),
  setAdminSystemIssueStatus: vi.fn(),
  getAdminRequestLogs: vi.fn(),
}))
vi.mock("@/lib/api", () => ({ apiClient: api }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { SystemIssuesPanel } from "@/components/admin/system-issues/system-issues-panel"

const now = new Date().toISOString()
const issue = {
  id: "al_9",
  fingerprint: "3f1c9a0b7d2e4f5a6b7c",
  title: "PrismaClientValidationError: Invalid `prisma.chatRun.findMany()` invocation: Unknown argument `nin`",
  culprit: "sweepStaleRuns (src/jobs/stale-run-watchdog.js)",
  kind: "base_de_datos",
  kindLabel: "Base de datos",
  level: "error",
  status: "nuevo",
  statusLabel: "Nuevo",
  regression: true,
  regressedAt: now,
  resolvedAt: null,
  resolvedBy: null,
  firstSeen: new Date(Date.now() - 3 * 86400000).toISOString(),
  lastSeen: now,
  count: 42,
  lines: 42,
  usersCount: 0,
  events24h: 12,
  sparkline: [0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 1, 2, 1],
  spike: false,
  lastHour: 1,
  hourlyAvg: 0.5,
  environment: "production",
  lastCommit: "93ee3919a1b2",
}

const detail = {
  ...issue,
  hours48: new Array(48).fill(0),
  samples: [{
    at: now,
    level: "error",
    source: "console",
    message: "[stale-run-watchdog] sweep failed: Invalid `prisma.chatRun.findMany()` invocation: Unknown argument `nin`",
    stack: "PrismaClientValidationError: Invalid\n    at async sweepStaleRuns (src/jobs/stale-run-watchdog.js:61:22)",
    topFrame: { fn: "sweepStaleRuns", file: "src/jobs/stale-run-watchdog.js", line: 61 },
    route: null, method: null, status: null, reqId: null, userId: null, chatId: null, queue: null,
    tag: "stale-run-watchdog", page: null, component: null, browser: null,
    environment: "production", commit: "93ee3919a1b2", host: "iliagpt-backend", burst: 12,
  }],
  users: [{ id: "u1", email: "luis@example.com", name: "Luis" }],
  reqIds: [],
  chatIds: [],
  commits: ["93ee3919a1b2"],
  linkedTurns: [{ id: "tf1", createdAt: now, category: "error_visible", categoryLabel: "Error visible", cause: "DeepSeek 500", prompt: "hola", userEmail: "luis@example.com", openLink: "/agentes/c1" }],
  history: [],
  spikeAt: null,
}

const stats = { serverTime: now, open: 3, new24h: 1, regressions: 1, events24h: 12, spikes: 0, resolved7d: 2, byKind: [{ kind: "base_de_datos", count: 1 }, { kind: "redis", count: 2 }] }

describe("SystemIssuesPanel («Errores del sistema»)", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("lists issues with culprit, status, regression, sparkline and counts", async () => {
    api.getAdminSystemIssues.mockResolvedValue({ items: [issue], total: 1, page: 1, limit: 25, serverTime: now })
    api.getAdminSystemIssueStats.mockResolvedValue(stats)
    render(<SystemIssuesPanel />)
    const row = await screen.findByTestId("system-issue-row")
    expect(within(row).getByText(issue.title)).toBeTruthy()
    expect(within(row).getByText(issue.culprit)).toBeTruthy()
    expect(within(row).getByText("Regresión")).toBeTruthy()
    expect(within(row).getByText("42")).toBeTruthy()
    expect(within(row).getByTestId("issue-sparkline").getAttribute("aria-label")).toBe("12 eventos en las últimas 24 horas")
    expect(api.getAdminSystemIssues).toHaveBeenCalledWith(expect.objectContaining({ status: "abiertos", sort: "recientes" }))
    await waitFor(() => expect(screen.getByText("Base de datos · 1")).toBeTruthy())
  })

  it("opens the drawer with stack, samples, affected users and linked failed turns; «Marcar resuelto» updates it", async () => {
    api.getAdminSystemIssues.mockResolvedValue({ items: [issue], total: 1, page: 1, limit: 25, serverTime: now })
    api.getAdminSystemIssueStats.mockResolvedValue(stats)
    api.getAdminSystemIssue.mockResolvedValue({ item: detail })
    api.setAdminSystemIssueStatus.mockResolvedValue({ item: { ...issue, status: "resuelto", statusLabel: "Resuelto", regression: false } })
    render(<SystemIssuesPanel />)
    fireEvent.click(await screen.findByTestId("system-issue-row"))
    const drawer = await screen.findByTestId("system-issue-detail")
    await waitFor(() => expect(within(drawer).getByTestId("system-issue-stack").textContent).toContain("sweepStaleRuns (src/jobs/stale-run-watchdog.js:61:22)"))
    expect(within(drawer).getByText("×12 líneas en ráfaga")).toBeTruthy()
    expect(within(within(drawer).getByTestId("system-issue-users")).getByText("luis@example.com")).toBeTruthy()
    expect(within(within(drawer).getByTestId("system-issue-linked-turns")).getByText("Error visible · DeepSeek 500")).toBeTruthy()

    fireEvent.click(within(drawer).getByTestId("system-issue-action-resuelto"))
    await waitFor(() => expect(api.setAdminSystemIssueStatus).toHaveBeenCalledWith("al_9", "resuelto"))
    await waitFor(() => expect(within(drawer).getByTestId("system-issue-status").textContent).toBe("Resuelto"))
    expect(within(drawer).getByTestId("system-issue-action-nuevo").textContent).toContain("Reabrir")
  })

  it("?fp=<fingerprint> (from a failed turn) finds the issue whatever its status", async () => {
    window.history.pushState({}, "", "/admin/logs?tab=errores&fp=3f1c9a0b7d2e4f5a6b7c")
    api.getAdminSystemIssues.mockResolvedValue({ items: [issue], total: 1, page: 1, limit: 25, serverTime: now })
    api.getAdminSystemIssueStats.mockResolvedValue(stats)
    render(<SystemIssuesPanel />)
    await waitFor(() => expect(api.getAdminSystemIssues).toHaveBeenCalledWith(expect.objectContaining({ status: "todos", q: "3f1c9a0b7d2e4f5a6b7c" })))
    window.history.pushState({}, "", "/")
  })

  it("shows a calm empty state when nothing is open", async () => {
    api.getAdminSystemIssues.mockResolvedValue({ items: [], total: 0, page: 1, limit: 25, serverTime: now })
    api.getAdminSystemIssueStats.mockResolvedValue({ ...stats, open: 0, byKind: [] })
    render(<SystemIssuesPanel />)
    expect((await screen.findByTestId("system-issues-empty")).textContent).toContain("Sin errores abiertos")
  })
})
