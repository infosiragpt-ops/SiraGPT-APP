import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import ChatAgentComputerPanel from "@/components/chat/chat-agent-computer-panel"
import { IntegratedBrowserBar } from "@/components/chat/integrated-browser-bar"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { postComputerNavigate } from "@/lib/computer-navigate-client"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import { coworkApi } from "@/lib/cowork-api"

const remote = vi.hoisted(() => ({ shell: vi.fn(), pane: vi.fn() }))
vi.mock("@/components/code/agent-computer-shell", () => ({ AgentComputerShell: (props: any) => { remote.shell(); return props.children } }))
vi.mock("@/components/code/department-computer-pane", () => ({ DepartmentComputerPane: () => { remote.pane(); return null } }))
vi.mock("@/lib/codex/api/projects", () => ({ projectsCodexApi: { previewStatus: vi.fn(), startPreview: vi.fn(), stopPreview: vi.fn() } }))
vi.mock("@/lib/codex/use-codex-health", () => ({ ensureCodexPreviewOrigin: vi.fn().mockResolvedValue(null) }))
vi.mock("@/lib/computer-navigate-client", () => ({ postComputerNavigate: vi.fn() }))
vi.mock("@/lib/authenticated-fetch", () => ({ authenticatedFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) }))
vi.mock("@/lib/cowork-api", () => ({ coworkApi: { ensureWorkspace: vi.fn().mockResolvedValue({ workspace: { id: "cw" } }), listScheduledTasks: vi.fn().mockResolvedValue({ tasks: [] }) } }))

const basePath = "/api/codex/projects/p1/preview/signed-capability/app/"
const projectPreview = { projectId: "p1", projectName: "Bici Nube", revision: 1 }

describe("project app in the chat browser", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(postComputerNavigate).mockResolvedValue("https://example.com/")
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ project: "p1", ready: true, running: true, basePath })
    vi.mocked(projectsCodexApi.stopPreview).mockResolvedValue({ ok: true })
  })

  it("renders the owned app in the browser without mounting the remote computer or exposing its capability in the address", async () => {
    const onClose = vi.fn()
    const view = render(<ChatAgentComputerPanel conversationId="chat-1" onClose={onClose} projectPreview={projectPreview} navigateUrl="https://example.com" startExpanded />)
    const iframe = await screen.findByTitle("Vista previa del proyecto")
    expect(screen.getByRole("region", { name: "Navegador del proyecto" })).toBeVisible()
    expect(iframe).toHaveAttribute("src", basePath)
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock")
    const address = screen.getByRole("textbox", { name: "Dirección del proyecto" })
    expect(address).toHaveValue("Bici Nube · Vista local")
    expect(address).toHaveAttribute("readonly")
    expect(screen.getByTestId("chat-project-browser").textContent).not.toContain("signed-capability")
    expect(screen.queryByRole("button", { name: "Ir" })).toBeNull()
    expect(remote.shell).not.toHaveBeenCalled()
    expect(remote.pane).not.toHaveBeenCalled()
    expect(coworkApi.ensureWorkspace).not.toHaveBeenCalled()
    expect(authenticatedFetch).not.toHaveBeenCalled()
    expect(postComputerNavigate).not.toHaveBeenCalled()
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cerrar navegador" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(projectsCodexApi.stopPreview).not.toHaveBeenCalled()
  })

  it("refreshes the app manually and on a verified revision, and Stop cannot be undone by another revision", async () => {
    const view = render(<ChatAgentComputerPanel conversationId="chat-1" onClose={vi.fn()} projectPreview={projectPreview} />)
    const first = await screen.findByTitle("Vista previa del proyecto")
    fireEvent.click(screen.getByRole("button", { name: "Recargar aplicación" }))
    const refreshed = screen.getByTitle("Vista previa del proyecto")
    expect(refreshed).not.toBe(first)
    view.rerender(<ChatAgentComputerPanel conversationId="chat-1" onClose={vi.fn()} projectPreview={{ ...projectPreview, revision: 2 }} />)
    await waitFor(() => expect(screen.getByTitle("Vista previa del proyecto")).not.toBe(refreshed))
    fireEvent.click(screen.getByRole("button", { name: "Detener aplicación" }))
    await waitFor(() => expect(projectsCodexApi.stopPreview).toHaveBeenCalledWith("p1"))
    view.rerender(<ChatAgentComputerPanel conversationId="chat-1" onClose={vi.fn()} projectPreview={{ ...projectPreview, revision: 3 }} />)
    expect(screen.queryByTitle("Vista previa del proyecto")).toBeNull()
    expect(screen.getByRole("button", { name: "Iniciar vista previa" })).toBeVisible()
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
    expect(postComputerNavigate).not.toHaveBeenCalled()
  })

  it("keeps the browser close control available while a stopped or unavailable project is recovered", async () => {
    vi.mocked(projectsCodexApi.previewStatus).mockResolvedValue({ project: "p1", ready: false, running: true, previewExpired: true, basePath: null })
    const onClose = vi.fn()
    render(<ChatAgentComputerPanel conversationId="chat-1" onClose={onClose} projectPreview={projectPreview} />)
    await screen.findByText(/El enlace de vista previa caducó/)
    expect(screen.getByRole("button", { name: "Recargar aplicación" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Cerrar navegador" }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(projectsCodexApi.startPreview).not.toHaveBeenCalled()
  })

  it("a project address cannot trigger remote navigation even if its form is submitted", async () => {
    render(<IntegratedBrowserBar conversationId="chat-1" initialUrl="https://example.com" readOnlyLabel="Bici Nube · Vista local" />)
    await act(async () => { fireEvent.submit(screen.getByTestId("integrated-browser-bar")) })
    expect(postComputerNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole("textbox", { name: "Dirección del proyecto" })).toHaveValue("Bici Nube · Vista local")
  })

  it("the regular browser still accepts manual navigation", async () => {
    vi.mocked(postComputerNavigate).mockResolvedValue("https://example.com/")
    render(<IntegratedBrowserBar conversationId="chat-1" autoNavigate={false} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Dirección del navegador" }), { target: { value: "https://example.com" } })
    fireEvent.click(screen.getByRole("button", { name: "Ir" }))
    await waitFor(() => expect(postComputerNavigate).toHaveBeenCalledWith("chat-1", "https://example.com/"))
  })
})
