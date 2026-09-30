import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useChatCodingWorkspace, useCloudCodingProjects } from "@/hooks/use-chat-coding-workspace"
import { coreCodexApi } from "@/lib/codex/api/core"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import { CODING_WORKSPACE_READY_EVENT, emitCodingWorkspaceReady } from "@/lib/chat/coding-workspace-event"
import type { CodexProject } from "@/lib/codex/api/types"

vi.mock("@/lib/codex/api/core", () => ({ coreCodexApi: { access: vi.fn() } }))
vi.mock("@/lib/codex/api/projects", () => ({ projectsCodexApi: { getProjectByChat: vi.fn(), listProjects: vi.fn() } }))

const project = (id: string, chatId: string): CodexProject => ({ id, chatId, name: `Proyecto ${id}`, status: "ready", workspacePath: null, previewUrl: null, error: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("chat cloud workspace ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(coreCodexApi.access).mockResolvedValue({ ok: true, enabled: true, canRun: true, allowlistConfigured: true })
    vi.mocked(projectsCodexApi.getProjectByChat).mockRejectedValue(new Error("project_not_found"))
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([])
  })

  it("does not transfer readiness across chats or accept a late lookup for the previous chat", async () => {
    const first = deferred<CodexProject>(), second = deferred<CodexProject>()
    vi.mocked(projectsCodexApi.getProjectByChat).mockImplementation((id) => id === "chat-a" ? first.promise : second.promise)
    const { result, rerender } = renderHook(({ chatId }) => useChatCodingWorkspace("user-a", chatId), { initialProps: { chatId: "chat-a" } })
    rerender({ chatId: "chat-b" })
    await act(async () => { first.resolve(project("a", "chat-a")) })
    expect(result.current.workspace).toBeNull()
    await act(async () => { second.resolve(project("b", "chat-b")) })
    expect(result.current.workspace?.projectId).toBe("b")
    rerender({ chatId: "chat-c" })
    expect(result.current.workspace).toBeNull()
  })

  it("a server-ready event activates only its own account and conversation", async () => {
    const { result, rerender } = renderHook(({ userId }) => useChatCodingWorkspace(userId, "chat-a"), { initialProps: { userId: "user-a" } })
    await act(async () => {
      emitCodingWorkspaceReady({ chatId: "chat-b", projectId: "b", projectName: "B" }, "user-a", "chat-b")
      emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "b", projectName: "B" }, "user-b", "chat-a")
    })
    expect(result.current.workspace).toBeNull()
    await act(async () => { emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "a", projectName: "A" }, "user-a", "chat-a") })
    expect(result.current.workspace?.projectId).toBe("a")
    rerender({ userId: "user-b" })
    expect(result.current.workspace).toBeNull()
  })

  it("reload discovers the durable binding without creating a project", async () => {
    vi.mocked(projectsCodexApi.getProjectByChat).mockResolvedValue(project("a", "chat-a"))
    const { result } = renderHook(() => useChatCodingWorkspace("user-a", "chat-a"))
    await waitFor(() => expect(result.current.workspace?.projectId).toBe("a"))
    expect(projectsCodexApi.getProjectByChat).toHaveBeenCalledWith("chat-a")
  })

  it("does not look up temporary chats", () => {
    renderHook(() => useChatCodingWorkspace("user-a", "temp-chat-123"))
    expect(projectsCodexApi.getProjectByChat).not.toHaveBeenCalled()
  })

  it("leaves anonymous and malformed events without an active workspace", () => {
    const { result } = renderHook(() => useChatCodingWorkspace(undefined, undefined))
    act(() => window.dispatchEvent(new CustomEvent(CODING_WORKSPACE_READY_EVENT)))
    expect(result.current.workspace).toBeNull()
    expect(projectsCodexApi.getProjectByChat).not.toHaveBeenCalled()
  })

  it("validates a workspace frame against the stream chat before emitting it", () => {
    const listener = vi.fn()
    window.addEventListener(CODING_WORKSPACE_READY_EVENT, listener)
    expect(emitCodingWorkspaceReady({ chatId: "other", projectId: "x", projectName: "X" }, "user-a", "chat-a")).toBe(false)
    expect(emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "x" }, "user-a", "chat-a")).toBe(false)
    expect(listener).not.toHaveBeenCalled()
    expect(emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "x", projectName: "X" }, "user-a", "chat-a")).toBe(true)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ chatId: "chat-a", projectId: "x", projectName: "X", userId: "user-a" })
    window.removeEventListener(CODING_WORKSPACE_READY_EVENT, listener)
  })
})

describe("durable project rows in Carpetas", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(coreCodexApi.access).mockResolvedValue({ ok: true, enabled: true, canRun: true, allowlistConfigured: true })
  })

  it("lists only chat-bound projects in one account-owned request", async () => {
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValue([project("a", "chat-a"), project("unbound", "")])
    const { result } = renderHook(() => useCloudCodingProjects("user-a"))
    await waitFor(() => expect(result.current.map((item) => item.id)).toEqual(["a"]))
    expect(projectsCodexApi.listProjects).toHaveBeenCalledTimes(1)
    expect(projectsCodexApi.getProjectByChat).not.toHaveBeenCalled()
  })

  it("hides old-account rows immediately and rejects a pending old-account result", async () => {
    const first = deferred<CodexProject[]>(), second = deferred<CodexProject[]>()
    vi.mocked(projectsCodexApi.listProjects).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(({ userId }) => useCloudCodingProjects(userId), { initialProps: { userId: "user-a" } })
    await waitFor(() => expect(projectsCodexApi.listProjects).toHaveBeenCalledTimes(1))
    rerender({ userId: "user-b" })
    expect(result.current).toEqual([])
    await waitFor(() => expect(projectsCodexApi.listProjects).toHaveBeenCalledTimes(2))
    await act(async () => { first.resolve([project("a", "chat-a")]) })
    expect(result.current).toEqual([])
    await act(async () => { second.resolve([project("b", "chat-b")]) })
    expect(result.current.map((item) => item.id)).toEqual(["b"])
  })

  it("refreshes on a matching ready event, retains owned rows during an outage and never persists local folders", async () => {
    vi.mocked(projectsCodexApi.listProjects).mockResolvedValueOnce([project("a", "chat-a")]).mockRejectedValueOnce(new Error("offline"))
    const writeStorage = vi.spyOn(Storage.prototype, "setItem")
    const { result } = renderHook(() => useCloudCodingProjects("user-a"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    await act(async () => { emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "a", projectName: "A" }, "user-b", "chat-a") })
    expect(projectsCodexApi.listProjects).toHaveBeenCalledTimes(1)
    await act(async () => { emitCodingWorkspaceReady({ chatId: "chat-a", projectId: "a", projectName: "A" }, "user-a", "chat-a") })
    await waitFor(() => expect(projectsCodexApi.listProjects).toHaveBeenCalledTimes(2))
    expect(result.current.map((item) => item.id)).toEqual(["a"])
    expect(writeStorage).not.toHaveBeenCalled()
    writeStorage.mockRestore()
  })

  it("does not list projects when account access is denied", async () => {
    vi.mocked(coreCodexApi.access).mockResolvedValue({ ok: true, enabled: true, canRun: false, allowlistConfigured: true })
    const { result } = renderHook(() => useCloudCodingProjects("user-a"))
    await waitFor(() => expect(coreCodexApi.access).toHaveBeenCalled())
    expect(result.current).toEqual([])
    expect(projectsCodexApi.listProjects).not.toHaveBeenCalled()
  })
})
