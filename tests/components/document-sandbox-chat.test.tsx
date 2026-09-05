import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocumentSandboxChat } from "@/lib/use-document-sandbox-chat"
import { documentJobState, serializeDocumentJobState, DocumentSandboxClientError, type DocumentJobSnapshot } from "@/lib/document-sandbox-client"

// Auxiliary React race probes with simulated transports. These do NOT meet
// SPEC §10.2 (only the provider SDK may be mocked for acceptance), do not edit
// real documents and are not E2E, golden, isolation or deployment evidence.
const transport = vi.hoisted(() => ({ prepare: vi.fn(), submit: vi.fn(), recover: vi.fn(), observe: vi.fn(), cancel: vi.fn() }))
const api = vi.hoisted(() => ({ createChat: vi.fn(), addMessage: vi.fn() }))
vi.mock("@/lib/api", () => ({ apiClient: api }))
vi.mock("@/lib/document-sandbox-client", async (original) => ({
  ...await original<typeof import("@/lib/document-sandbox-client")>(), documentSandboxClient: transport,
}))
type Chat = NonNullable<Parameters<typeof useDocumentSandboxChat>[0]["currentChat"]>
const hash = "a".repeat(64)
const completed: DocumentJobSnapshot = { id: "job-1", status: "done", eventSeq: 7, admissionReady: true, errorCode: null, outcome: "edited", artifacts: [
  { id: "out-1", name: "informe.docx", kind: "output", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4, sha256: hash },
  { id: "report-1", name: "validation_report.json", kind: "validation_report", mime: "application/json", size: 20, sha256: hash },
] }
const queued: DocumentJobSnapshot = { ...completed, status: "queued", artifacts: [], eventSeq: 1 }
function chat(id = "chat-1", messages: Chat["messages"] = []): Chat {
  return { id, title: "Documento", userId: "user-1", model: "chosen", createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z", messages }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((res) => { resolve = res }), resolve: (value: T) => resolve(value) }
}
function harness(initial = chat()) {
  const markBusy = vi.fn(); const markIdle = vi.fn(); const notify = vi.fn()
  const rendered = renderHook(() => {
    const [currentChat, setCurrentChat] = useState<Chat | null>(initial)
    const [userId, setUserId] = useState<string | null>("user-1")
    const flow = useDocumentSandboxChat({ currentChat, setCurrentChat, userId, selectedModel: "chosen",
      markBusy, markIdle, notify, selectChat: async () => {} })
    return { ...flow, currentChat, setCurrentChat, setUserId }
  })
  return { ...rendered, markBusy, markIdle, notify }
}
describe("document sandbox canonical chat wiring (transport unit tests, not validation E2E)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transport.prepare.mockResolvedValue(new FormData())
    transport.submit.mockResolvedValue(queued)
    transport.recover.mockResolvedValue(completed)
    transport.observe.mockImplementation(async (_id: string, update: (value: DocumentJobSnapshot) => void) => { update(completed); return completed })
    transport.cancel.mockResolvedValue({ ...queued, status: "cancelled" })
    api.addMessage.mockImplementation(async (chatId: string, value: { role: "USER" | "ASSISTANT"; content: string; metadata?: unknown }) => ({ message: {
      id: value.role === "USER" ? "user-message" : "assistant-message", chatId, ...value, timestamp: "2026-09-04T00:00:00Z",
    } }))
  })
  afterEach(cleanup)

  it("persists both messages and the admission pointer before submitting, then reuses the original bubble", async () => {
    const view = harness()
    await act(async () => { await view.result.current.start("edita el título", [], "turn-1") })
    expect(api.addMessage).toHaveBeenCalledTimes(2)
    expect(api.addMessage.mock.invocationCallOrder[1]).toBeLessThan(transport.submit.mock.invocationCallOrder[0])
    expect(api.addMessage.mock.calls[1][1].metadata).toEqual({ source: "doc-sandbox", docSandbox: { version: 1, idempotencyKey: "doc-turn-1" } })
    expect(view.result.current.currentChat?.messages).toHaveLength(2)
    const message = view.result.current.currentChat!.messages[1]
    expect(message.id).toBe("assistant-message")
    expect(message.content).toContain("informe.docx")
    expect(message.content).toContain("?download=1")
    expect(message.content).not.toContain("signature=")
    expect(view.markIdle).toHaveBeenCalledOnce()
  })
  it("navigation never cancels a server job or steals the other chat's messages", async () => {
    const submitted = deferred<DocumentJobSnapshot>()
    transport.submit.mockReturnValue(submitted.promise)
    const view = harness()
    let run!: Promise<boolean>
    act(() => { run = view.result.current.start("edita el título", [], "turn-2") })
    await waitFor(() => expect(transport.submit).toHaveBeenCalledOnce())
    act(() => { view.result.current.setCurrentChat(chat("chat-2")) })
    await act(async () => { submitted.resolve(queued); await run })
    expect(view.result.current.currentChat?.id).toBe("chat-2")
    expect(view.result.current.currentChat?.messages).toHaveLength(0)
    expect(transport.cancel).not.toHaveBeenCalled()
  })
  it("Stop remains busy until durable cancellation is acknowledged and cannot stop a different chat", async () => {
    const observed = deferred<DocumentJobSnapshot>()
    const cancelled = deferred<DocumentJobSnapshot>()
    transport.observe.mockReturnValue(observed.promise)
    transport.cancel.mockReturnValue(cancelled.promise)
    const view = harness()
    let run!: Promise<boolean>
    act(() => { run = view.result.current.start("edita el título", [], "turn-3") })
    await waitFor(() => expect(transport.observe).toHaveBeenCalledOnce())
    expect(view.result.current.stop("other-chat")).toBe(false)
    act(() => { expect(view.result.current.stop("chat-1")).toBe(true) })
    expect(view.markIdle).not.toHaveBeenCalled()
    await act(async () => { cancelled.resolve({ ...queued, status: "cancelled" }) })
    expect(view.markIdle).toHaveBeenCalledOnce()
    expect(view.result.current.currentChat!.messages[1].content).toContain("Edición cancelada")
    await act(async () => { observed.resolve(completed); await run })
    expect(view.result.current.currentChat!.messages[1].content).not.toContain("informe.docx")
  })
  it("a persisted pointer recovers a missed terminal result without resubmitting the job", async () => {
    const initial = chat("chat-1", [{ id: "persisted-assistant", chatId: "chat-1", role: "ASSISTANT", timestamp: "2026-09-04T00:00:00Z",
      content: serializeDocumentJobState(documentJobState()), metadata: JSON.stringify({ source: "doc-sandbox", docSandbox: { version: 1, idempotencyKey: "doc-reload" } }) }])
    const view = harness(initial)
    await waitFor(() => expect(view.result.current.currentChat!.messages[0].content).toContain("informe.docx"))
    expect(transport.recover).toHaveBeenCalledOnce()
    expect(transport.submit).not.toHaveBeenCalled()
    expect(api.addMessage).not.toHaveBeenCalled()
  })
  it("Stop during pointer persistence prevents later paid submission", async () => {
    const assistant = deferred<unknown>()
    api.addMessage.mockImplementation(async (chatId: string, value: { role: string; content: string }) => value.role === "ASSISTANT"
      ? assistant.promise : { message: { id: "user-message", chatId, ...value } })
    const view = harness()
    const abort = new AbortController()
    let run!: Promise<boolean>
    act(() => { run = view.result.current.start("edita el título", [], "turn-stop-before-post", abort.signal) })
    await waitFor(() => expect(api.addMessage).toHaveBeenCalledTimes(2))
    await act(async () => {
      abort.abort(new DOMException("Stopped", "AbortError"))
      assistant.resolve({ message: { id: "assistant-message" } })
      await expect(run).rejects.toMatchObject({ name: "AbortError" })
    })
    expect(transport.submit).not.toHaveBeenCalled()
  })
  it("definitive POST rejection releases busy and rejects start so the composer retains its draft", async () => {
    transport.submit.mockRejectedValue(new DocumentSandboxClientError("E_MODEL", 400, true))
    const view = harness()
    await act(async () => { await expect(view.result.current.start("edita el título", [], "rejected")).rejects.toMatchObject({ code: "E_MODEL", admissionRejected: true }) })
    expect(view.markIdle).toHaveBeenCalledOnce()
    expect(view.result.current.stop("chat-1")).toBe(false)
    expect(view.result.current.currentChat!.messages[1].content).toContain('"done":true')
    expect(view.result.current.currentChat!.messages[1].content).not.toContain("informe.docx")
    expect(transport.recover).not.toHaveBeenCalled()
    expect(transport.observe).not.toHaveBeenCalled()
  })
  it("auth failure suspends exactly once; self renders and stale refreshes never trigger a recovery loop", async () => {
    const initial = chat("chat-1", [{ id: "persisted-assistant", chatId: "chat-1", role: "ASSISTANT", timestamp: "2026-09-04T00:00:00Z",
      content: serializeDocumentJobState(documentJobState()), metadata: { docSandbox: { version: 1, idempotencyKey: "doc-auth" } } }])
    transport.recover.mockRejectedValueOnce(new DocumentSandboxClientError("E_AUTH", 401))
    const view = harness(initial)
    await waitFor(() => expect(view.notify).toHaveBeenCalledOnce())
    for (let index = 0; index < 5; index++) await act(async () => { view.result.current.setCurrentChat({ ...initial }) })
    expect(transport.recover).toHaveBeenCalledOnce()
    expect(view.markIdle).toHaveBeenCalledOnce()
    expect(view.result.current.currentChat!.messages[0].content).toContain("Tu sesión expiró")
    await act(async () => { view.result.current.setCurrentChat(chat("other")) })
    await act(async () => { view.result.current.setCurrentChat(initial) })
    await waitFor(() => expect(view.result.current.currentChat!.messages[0].content).toContain("informe.docx"))
    expect(transport.recover).toHaveBeenCalledTimes(2)
    expect(transport.submit).not.toHaveBeenCalled()
  })
  it("an orphaned pointer releases busy after bounded 404 recovery and does not claim server cancellation", async () => {
    const initial = chat("chat-1", [{ id: "orphan", chatId: "chat-1", role: "ASSISTANT", timestamp: "2026-09-04T00:00:00Z",
      content: serializeDocumentJobState(documentJobState()), metadata: { docSandbox: { version: 1, idempotencyKey: "doc-orphan" } } }])
    transport.recover.mockRejectedValue(new DocumentSandboxClientError("E_ADMISSION_NOT_FOUND"))
    const view = harness(initial)
    await waitFor(() => expect(view.markIdle).toHaveBeenCalledOnce())
    await act(async () => { view.result.current.setCurrentChat({ ...initial }) })
    expect(transport.recover).toHaveBeenCalledOnce()
    expect(view.result.current.currentChat!.messages[0].content).toContain("Vuelve a adjuntar el original")
    expect(view.result.current.currentChat!.messages[0].content).not.toContain("Edición cancelada")
    expect(view.result.current.stop("chat-1")).toBe(false)
    expect(transport.submit).not.toHaveBeenCalled()
    expect(transport.cancel).not.toHaveBeenCalled()
  })
  it("uncertain admission keeps the pointer, releases the spinner and only Stop can request cancellation", async () => {
    transport.submit.mockRejectedValue(new DocumentSandboxClientError("E_ADMISSION_UNKNOWN"))
    const view = harness()
    await act(async () => { await view.result.current.start("edita el título", [], "uncertain") })
    expect(view.markIdle).toHaveBeenCalledOnce()
    expect(view.result.current.currentChat!.messages[1].content).toContain("No se pudo confirmar la recepción")
    expect(transport.recover).not.toHaveBeenCalled()
    expect(transport.cancel).not.toHaveBeenCalled()
    await act(async () => { expect(view.result.current.stop("chat-1")).toBe(true) })
    expect(transport.cancel).toHaveBeenCalledOnce()
    expect(view.result.current.currentChat!.messages[1].content).toContain("Edición cancelada")
  })
  it("concurrent queued sends cannot persist or submit a second admission during upload preflight", async () => {
    const prepared = deferred<FormData>()
    transport.prepare.mockReturnValueOnce(prepared.promise)
    const view = harness()
    let first!: Promise<boolean>
    act(() => { first = view.result.current.start("edita el título", [], "first") })
    await act(async () => { await expect(view.result.current.start("edita el título", [], "second")).rejects.toMatchObject({ code: "E_CONFLICT" }) })
    expect(api.addMessage).not.toHaveBeenCalled()
    await act(async () => { prepared.resolve(new FormData()); await first })
    expect(transport.submit).toHaveBeenCalledOnce()
    expect(api.addMessage).toHaveBeenCalledTimes(2)
  })
  it("logout during upload preflight cannot submit under the old identity", async () => {
    const prepared = deferred<FormData>()
    transport.prepare.mockReturnValueOnce(prepared.promise)
    const view = harness()
    let run!: Promise<boolean>
    act(() => { run = view.result.current.start("edita el título", [], "old-owner") })
    await act(async () => { view.result.current.setUserId(null) })
    await act(async () => { prepared.resolve(new FormData()); await expect(run).rejects.toMatchObject({ code: "E_CANCELLED" }) })
    expect(api.addMessage).not.toHaveBeenCalled()
    expect(transport.submit).not.toHaveBeenCalled()
  })
  it("pointer hydration during addMessage cannot create a competing observer for the foreground admission", async () => {
    const saved = { id: "assistant-message", chatId: "chat-1", role: "ASSISTANT" as const, timestamp: "2026-09-04T00:00:00Z",
      content: serializeDocumentJobState(documentJobState()), metadata: { docSandbox: { version: 1, idempotencyKey: "doc-racing-refresh" } } }
    const assistant = deferred<{ message: typeof saved }>()
    api.addMessage.mockImplementation(async (chatId: string, value: { role: string; content: string }) => value.role === "ASSISTANT"
      ? assistant.promise : { message: { id: "user-message", chatId, ...value } })
    const view = harness()
    let run!: Promise<boolean>
    act(() => { run = view.result.current.start("edita el título", [], "racing-refresh") })
    await waitFor(() => expect(api.addMessage).toHaveBeenCalledTimes(2))
    await act(async () => { view.result.current.setCurrentChat(chat("chat-1", [saved])) })
    expect(transport.recover).not.toHaveBeenCalled()
    await act(async () => { assistant.resolve({ message: saved }); await run })
    expect(transport.submit).toHaveBeenCalledOnce()
    expect(transport.observe).toHaveBeenCalledOnce()
    expect(view.markBusy).toHaveBeenCalledOnce()
  })
})
