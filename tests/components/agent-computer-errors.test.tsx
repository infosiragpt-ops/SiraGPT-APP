import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: transport }))
vi.mock("next-intl", () => {
  const translate = (key: string) => key
  return { useTranslations: () => translate }
})
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="live-desktop-viewer" /> }))
vi.mock("@/components/code/ComputerViewer", () => ({ ComputerViewer: () => <div data-testid="iframe-viewer" /> }))
vi.mock("@/components/chat/integrated-browser-bar", () => ({ IntegratedBrowserBar: () => null }))
vi.mock("@/lib/code-workspace-context", () => ({
  CODE_PREVIEW_STATE_EVENT: "preview-test",
  CODE_ACTIVE_DEPARTMENT_SELECTION_EVENT: "department-test",
  getActiveDepartmentSelection: () => null,
}))

import { AgentComputerShell } from "@/components/code/agent-computer-shell"
import { DepartmentComputerPane } from "@/components/code/department-computer-pane"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
})
const serverDetail = "orchestrator failed; Bearer private-test-value; model_id=deepseek-v4-pro"

beforeEach(() => { transport.mockReset() })
afterEach(() => { cleanup() })

describe("computer dock reports confirmed actions", () => {
  it.each([
    [503, { ok: false, message: serverDetail }],
    [200, { ok: false, message: serverDetail }],
    [200, {}],
  ])("never claims focus for status %s without a successful result", async (status, body) => {
    transport.mockResolvedValue(json(body, status))
    render(<AgentComputerShell initialDock="desktop" variant="overlay" conversationId="focus-error">
      <div />
    </AgentComputerShell>)
    fireEvent.click(screen.getByRole("button", { name: "dock.files" }))
    await waitFor(() => expect(screen.getByTestId("agent-computer-focus-note")).toHaveTextContent("dock.unavailable"))
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0][0]).toMatch(/\/agent-computer\/action$/)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ focus: "files", conversationId: "focus-error" })
    expect(document.body.textContent).not.toContain(serverDetail)
  })

  it("confirms a successful focus response", async () => {
    transport.mockResolvedValue(json({ ok: true, focus: "terminal" }))
    render(<AgentComputerShell initialDock="desktop" variant="overlay"><div /></AgentComputerShell>)
    fireEvent.click(screen.getByRole("button", { name: "dock.terminal" }))
    await waitFor(() => expect(screen.getByTestId("agent-computer-focus-note")).toHaveTextContent("dock.focusedOther"))
  })
})

describe("preferred agent computer acquisition failures", () => {
  it.each([
    [true, 0],
    [false, 2],
  ])("shows a safe terminal error despite legacy pool enabled=%s warm=%s", async (enabled, poolWarm) => {
    const onStatusChange = vi.fn()
    transport.mockImplementation(async (url: string) => {
      if (url.endsWith("/desktop/status")) return json({ enabled, poolWarm })
      return json({ error: "forbidden", message: serverDetail }, 403)
    })
    render(<DepartmentComputerPane departmentName="Prueba" departmentId="qa" computerRunId="qa"
      conversationId={`failed-${enabled}-${poolWarm}`} embedded preferAgentComputer
      onClose={() => {}} onStatusChange={onStatusChange} />)
    expect(await screen.findByTestId("desktop-error-card")).toBeVisible()
    expect(screen.queryByTestId("desktop-preparing-label")).toBeNull()
    expect(screen.getByTestId("desktop-error-message")).toHaveTextContent("No se pudo abrir la computadora")
    expect(document.body.textContent).not.toMatch(/Bearer|private-test-value|deepseek|model_id|Preparando escritorio/)
    expect(onStatusChange).toHaveBeenLastCalledWith("error")
    expect(transport.mock.calls.filter(([url]) => String(url).includes("/agent-computer/sessions"))).toHaveLength(1)
    expect(transport.mock.calls.some(([url]) => String(url).includes("/desktop/sessions"))).toBe(false)
  })

  it("stops after bounded transient failures and recovers only after the existing retry button", async () => {
    let recovered = false
    let acquisitions = 0
    const onStatusChange = vi.fn()
    transport.mockImplementation(async (url: string) => {
      if (url.endsWith("/desktop/status")) return json({ enabled: true, poolWarm: 2 })
      if (url.includes("/agent-computer/sessions")) {
        acquisitions++
        return recovered
          ? json({ sessionId: "qa-recovered", conversationBound: true })
          : json({ error: "runner_unreachable", message: serverDetail }, 503)
      }
      return json({ ok: true })
    })
    render(<DepartmentComputerPane departmentName="Prueba" departmentId="qa" computerRunId="qa"
      conversationId="retry-after-terminal" embedded preferAgentComputer
      onClose={() => {}} onStatusChange={onStatusChange} />)
    expect(await screen.findByTestId("desktop-error-card", {}, { timeout: 5000 })).toBeVisible()
    expect(acquisitions).toBe(3)
    expect(screen.getByTestId("desktop-error-message")).not.toHaveTextContent("Preparando")
    expect(onStatusChange).toHaveBeenLastCalledWith("error")
    recovered = true
    fireEvent.click(screen.getByTestId("desktop-retry"))
    expect(await screen.findByTestId("live-desktop-viewer")).toBeVisible()
    expect(screen.queryByTestId("desktop-error-card")).toBeNull()
    expect(acquisitions).toBe(4)
    expect(screen.getByTestId("department-computer-pane")).toHaveAttribute("data-conversation-bound", "1")
  }, 7000)
})
