import { act, cleanup, renderHook } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDocumentEditorChat } from "@/lib/use-document-editor-chat"
import { resolveDocumentSandboxAdmission } from "@/lib/document-sandbox-routing"

// Transport regression only: proves target/model pinning, not real Office editing.
const api = vi.hoisted(() => ({ createChat: vi.fn(), editDocumentStream: vi.fn(), stopAIStream: vi.fn() }))
vi.mock("@/lib/api", () => ({ apiClient: api }))
type Chat = NonNullable<Parameters<typeof useDocumentEditorChat>[0]["currentChat"]>
function harness() {
  return renderHook(() => {
    const [currentChat, setCurrentChat] = useState<Chat | null>({
      id: "chat-1", title: "Documentos", userId: "user-1", model: "chosen", messages: [],
      createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
    })
    return useDocumentEditorChat({ currentChat, setCurrentChat, userId: "user-1", selectedModel: "chosen",
      selectProvider: "picked-provider", selectChat: vi.fn(), markBusy: vi.fn(), markIdle: vi.fn(), notify: vi.fn() })
  })
}

describe("document editor selected target", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.editDocumentStream.mockImplementation(async (_request, emit) => {
      emit({ type: "start", streamId: "stream-1" })
      emit({ type: "done", ok: true, content: "Edición terminada", files: [], assistantMessageId: "result-1", chatId: "chat-1" })
    })
  })
  afterEach(cleanup)

  it("sends the opened artifact version instead of the last document of a mixed conversation", async () => {
    const view = harness()
    const decision = resolveDocumentSandboxAdmission("cambia el título", {
      previewAttachments: [{ filename: "Presentación.pptx", artifactId: "ABCDEF123456", sourceFileId: "original-upload" }],
      historyAttachments: [{ id: "newer-upload", name: "Tabla.xlsx" }],
    })
    await act(async () => { await view.result.current.start("cambia el título", decision.attachments, "turn-1") })
    expect(api.editDocumentStream).toHaveBeenCalledOnce()
    expect(api.editDocumentStream.mock.calls[0][0]).toMatchObject({ fileIds: ["artifact:abcdef123456"], model: "chosen", provider: "picked-provider" })
  })

  it("sends all newly attached documents ahead of an opened artifact", async () => {
    const view = harness()
    const decision = resolveDocumentSandboxAdmission("corrige el título en ambos documentos", {
      attachments: [{ id: "new-word", name: "Informe.docx" }, { id: "new-excel", name: "Tabla.xlsx" }],
      previewAttachments: [{ filename: "Anterior.pptx", artifactId: "abcdef123456" }],
    })
    await act(async () => { await view.result.current.start("corrige el título en ambos documentos", decision.attachments, "turn-2") })
    expect(api.editDocumentStream.mock.calls[0][0].fileIds).toEqual(["new-word", "new-excel"])
  })

  it("retains server latest-version lookup for a follow-up with no active preview", async () => {
    const view = harness()
    const decision = resolveDocumentSandboxAdmission("cambia el título", { historyAttachments: [{ id: "old-upload", name: "Informe.docx" }] })
    await act(async () => { await view.result.current.start("cambia el título", decision.attachments, "turn-3") })
    expect(api.editDocumentStream.mock.calls[0][0].fileIds).toEqual([])
  })

  it("rejects an unresolved selected source before dispatch instead of editing the latest document", async () => {
    const view = harness()
    await act(async () => {
      await expect(view.result.current.start("cambia el título", [{ name: "Informe.docx", url: "https://example.com/informe.docx" }], "turn-4"))
        .rejects.toMatchObject({ code: "E_PARAMS" })
    })
    expect(api.editDocumentStream).not.toHaveBeenCalled()
    expect(api.createChat).not.toHaveBeenCalled()
  })
})
