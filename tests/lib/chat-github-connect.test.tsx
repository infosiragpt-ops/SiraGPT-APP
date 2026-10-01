import { act, renderHook, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { useChatGithubConnect } from "@/hooks/use-chat-github-connect"
import { githubService } from "@/lib/github-service"
import { emitGithubConnectionRequired, GITHUB_CONNECTION_CANCEL_EVENT, GITHUB_CONNECTION_TURN_SETTLED_EVENT } from "@/lib/chat/github-connect-handoff"

vi.mock("@/lib/github-service", () => ({ githubService: { status: vi.fn(), connectUrl: vi.fn(), connectStatus: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { message: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/lib/api-base-url", () => ({ getSameOriginApiBaseUrl: () => "http://localhost:5000/api" }))
const handoffId = "c263cda8-0f8a-42cc-9546-3952e0ff992a"
const detail = { userId: "u", chatId: "c", handoffId }
const authUrl = "https://github.com/login/oauth/authorize?client_id=public-id&state=private-state"
function makePopup() { return { closed: false, close: vi.fn(), location: { href: "about:blank" }, document: { title: "", body: { textContent: "" } } } }
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000) }) }
const emit = () => act(() => { emitGithubConnectionRequired(detail, "u", "c") })
function success() { vi.mocked(githubService.connectStatus).mockResolvedValue({ ...detail, status: "success", connectionVersion: "new" }); vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, verified: true, connectionVersion: "new" }) }

describe("GitHub authorization from the current chat", () => {
  let popup: ReturnType<typeof makePopup>
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks(); sessionStorage.clear()
    popup = makePopup()
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
    vi.mocked(githubService.connectUrl).mockResolvedValue({ url: authUrl, chatId: "c", handoffId })
    vi.mocked(githubService.connectStatus).mockResolvedValue({ ...detail, status: "pending" })
    vi.mocked(githubService.status).mockResolvedValue({ connected: false, configured: true, verified: false })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

  it("reserves a tab synchronously, navigates only to the server OAuth URL and never stores that URL", async () => {
    const { result } = renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected: vi.fn() }))
    act(() => result.current.reserve("pásame el link de GitHub para loguearme"))
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(githubService.connectUrl).not.toHaveBeenCalled()
    emit(); await flush()
    expect(window.open).toHaveBeenCalledTimes(1)
    expect(popup.location.href).toBe(authUrl)
    expect(sessionStorage.getItem("siragpt:github-handoff:u")).not.toMatch(/private-state|public-id|https/)
  })

  it("closes the reserved blank tab immediately when the turn finishes without requesting authorization", () => {
    const { result } = renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected: vi.fn() }))
    act(() => result.current.reserve("conecta GitHub"))
    act(() => window.dispatchEvent(new CustomEvent(GITHUB_CONNECTION_TURN_SETTLED_EVENT, { detail })))
    expect(popup.close).toHaveBeenCalledTimes(1)
    expect(githubService.connectUrl).not.toHaveBeenCalled()
  })

  it("rejects a different connection version even after this handoff succeeded", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); success()
    vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, verified: true, connectionVersion: "different-account" })
    await tick(); expect(onConnected).not.toHaveBeenCalled()
  })

  it("requires the matching callback receipt and live verification, then resumes once after the original turn settles", async () => {
    const onConnected = vi.fn()
    const { rerender } = renderHook(({ busy }) => useChatGithubConnect({ userId: "u", chatId: "c", busy, onConnected }), { initialProps: { busy: true } })
    emit(); await flush()
    vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, verified: true })
    await tick(); expect(onConnected).not.toHaveBeenCalled(); expect(githubService.status).not.toHaveBeenCalled()
    vi.mocked(githubService.connectStatus).mockResolvedValue({ ...detail, status: "success", connectionVersion: "new" })
    vi.mocked(githubService.status).mockResolvedValue({ connected: true, configured: true, verified: false })
    await tick(); expect(onConnected).not.toHaveBeenCalled()
    success(); await tick(); expect(onConnected).not.toHaveBeenCalled()
    rerender({ busy: false }); await flush()
    expect(onConnected).toHaveBeenCalledExactlyOnceWith(detail)
    emit(); await tick(); expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it("recovers a blocked popup from a user click without issuing a second OAuth state", async () => {
    vi.mocked(window.open).mockReturnValueOnce(null).mockReturnValue(popup as unknown as Window)
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected: vi.fn() }))
    emit(); await flush()
    const notice = vi.mocked(toast.message).mock.calls.find(([, options]) => options?.action && typeof options.action === "object" && options.action.label === "Abrir GitHub")
    expect(notice).toBeTruthy()
    act(() => { const action = notice![1]!.action as { onClick: () => void }; action.onClick() })
    expect(popup.location.href).toBe(authUrl)
    expect(githubService.connectUrl).toHaveBeenCalledTimes(1)
  })

  it("never interprets a connected account from another handoff as authorization", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); success()
    vi.mocked(githubService.connectStatus).mockResolvedValue({ chatId: "other", handoffId, status: "success" })
    await tick(); expect(onConnected).not.toHaveBeenCalled()
    vi.mocked(githubService.connectStatus).mockResolvedValue({ ...detail, status: "error", error: "denied" })
    await tick(); expect(onConnected).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalled()
    expect(toast.dismiss).toHaveBeenCalledWith(`github-${handoffId}`)
    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining("no se completó"), { id: `github-result-${handoffId}` })
  })

  it("rejects foreign callback origins, sources and identifiers; even the valid callback only wakes a server check", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush()
    const data = { type: "github_oauth_result", service: "github", status: "success", ...detail }
    for (const input of [
      { origin: "https://evil.test", source: popup }, { origin: "http://localhost:5000", source: window },
      { origin: "http://localhost:5000", source: popup, data: { ...data, chatId: "other" } },
    ]) act(() => window.dispatchEvent(new MessageEvent("message", { ...input, source: input.source as unknown as Window, data: input.data || data })))
    await flush(); expect(githubService.connectStatus).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "http://localhost:5000", source: popup as unknown as Window, data })))
    await flush(); expect(githubService.connectStatus).toHaveBeenCalledTimes(1); expect(onConnected).not.toHaveBeenCalled()
  })

  it("keeps a COOP-detached popup pending and resumes only in its original visible chat", async () => {
    const onConnected = vi.fn()
    const { rerender } = renderHook(({ chatId }) => useChatGithubConnect({ userId: "u", chatId, busy: false, onConnected }), { initialProps: { chatId: "c" } })
    emit(); await flush(); popup.closed = true; success()
    rerender({ chatId: "other" }); await tick(); expect(onConnected).not.toHaveBeenCalled()
    rerender({ chatId: "c" }); await flush(); expect(onConnected).toHaveBeenCalledExactlyOnceWith(detail)
  })

  it("cancels from Stop and ignores a late successful callback", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush()
    act(() => window.dispatchEvent(new CustomEvent(GITHUB_CONNECTION_CANCEL_EVENT, { detail })))
    success(); await tick(); expect(onConnected).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalled()
  })

  it("offers cancellation while waiting even after the stream has finished", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush()
    const notice = vi.mocked(toast.message).mock.calls.find(([, options]) => options?.action && typeof options.action === "object" && options.action.label === "Cancelar")
    expect(notice).toBeTruthy()
    act(() => { const action = notice![1]!.action as { onClick: () => void }; action.onClick() })
    success(); await tick(); expect(onConnected).not.toHaveBeenCalled()
  })

  it("never transfers a pending OAuth result into another account", async () => {
    const onConnected = vi.fn()
    const { rerender } = renderHook(({ userId }) => useChatGithubConnect({ userId, chatId: "c", busy: false, onConnected }), { initialProps: { userId: "u" } })
    emit(); await flush(); rerender({ userId: "different" }); success(); await tick()
    expect(onConnected).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalled()
  })

  it("rehydrates only correlation IDs, rechecks receipt and status, and consumes once across reloads", async () => {
    const onConnected = vi.fn()
    const first = renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); first.unmount(); expect(popup.close).not.toHaveBeenCalled()
    success()
    const second = renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    await flush(); expect(onConnected).toHaveBeenCalledTimes(1); second.unmount()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); await tick(); expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it("retries a failed verification without consuming the handoff proof", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); success()
    vi.mocked(githubService.status).mockRejectedValueOnce(new Error("503"))
    await tick(); expect(onConnected).not.toHaveBeenCalled()
    await tick(); expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it("stops waiting and offers reconnection when verification confirms a revoked or different account", async () => {
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush(); success()
    vi.mocked(githubService.status).mockResolvedValue({ connected: false, configured: true, verified: false, reconnectRequired: true, code: "github_token_invalid" })
    await tick()
    expect(onConnected).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("nueva autorización"), { id: `github-result-${handoffId}` })
    expect(popup.close).toHaveBeenCalled()
    const checks = vi.mocked(githubService.connectStatus).mock.calls.length
    await tick(); expect(githubService.connectStatus).toHaveBeenCalledTimes(checks)
  })

  it("expires even when an OAuth start request never returns", async () => {
    vi.mocked(githubService.connectUrl).mockImplementation(() => new Promise(() => {}))
    const onConnected = vi.fn()
    renderHook(() => useChatGithubConnect({ userId: "u", chatId: "c", busy: false, onConnected }))
    emit(); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(onConnected).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem("siragpt:github-handoff:u") || "[]")).toEqual([])
  })
})
