import { beforeEach, describe, expect, it } from "vitest"

import {
  clearPersistedComposerQueues,
  createPersistedComposerQueueItem,
  readPersistedComposerQueue,
  projectQueuedComposerMessages,
  isComposerQueueChatPaused,
  serializeComposerQueueFiles,
  writePersistedComposerQueue,
} from "@/lib/chat/composer-queue"

const queueItem = (overrides: Partial<Parameters<typeof createPersistedComposerQueueItem>[0]> = {}) =>
  createPersistedComposerQueueItem({
    id: "queue-1",
    ownerId: "user-a",
    chatId: "chat-a",
    msg: "continúa con el informe",
    files: [],
    idempotencyKey: "send-1",
    createdAt: "2026-08-09T12:00:00.000Z",
    ...overrides,
  })

describe("durable composer queue", () => {
  beforeEach(() => window.localStorage.clear())

  it("persists only attachments with a stable backend upload id", () => {
    const serialized = serializeComposerQueueFiles([
      { tempId: "temporary-only", name: "todavía-subiendo.docx" },
      { artifactId: "artifact-only", name: "preview.docx" },
      {
        fileId: "upload-123",
        tempId: "temporary-copy",
        name: "informe.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ignoredSecret: "must-not-leak",
        editRegion: { page: 1, start: 8, end: 19 },
      },
    ])

    expect(serialized).toHaveLength(1)
    expect(serialized[0]).toMatchObject({
      fileId: "upload-123",
      name: "informe.docx",
      editRegion: { page: 1, start: 8, end: 19 },
    })
    expect(serialized[0]).not.toHaveProperty("tempId")
    expect(serialized[0]).not.toHaveProperty("ignoredSecret")
  })

  it("bounds the number of durable attachments per queued task", () => {
    const serialized = serializeComposerQueueFiles(
      Array.from({ length: 60 }, (_, index) => ({ fileId: `upload-${index}`, name: `file-${index}.txt` })),
    )

    expect(serialized).toHaveLength(50)
    expect(serialized.at(-1)?.fileId).toBe("upload-49")
  })

  it("restores all 50 recording IDs and failures after a reload", () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ id: `audio-${index}`, name: `${index}.mp3`, mimeType: "audio/mpeg", processingStage: index === 23 ? "failed" : "extracting" }))
    expect(writePersistedComposerQueue("user-a", [queueItem({ msg: "transcribe y analiza", files })])).toBe(true)
    const restored = readPersistedComposerQueue("user-a")[0]
    expect(restored.files.map((f) => f.id)).toEqual(files.map((f) => f.id))
    expect(restored.files[23].processingStage).toBe("failed")
  })

  it("preserves FIFO order and idempotency keys per account", () => {
    const first = queueItem()
    const second = queueItem({ id: "queue-2", msg: "segunda tarea", idempotencyKey: "send-2" })

    expect(writePersistedComposerQueue("user-a", [first, second])).toBe(true)

    expect(readPersistedComposerQueue("user-a")).toEqual([first, second])
    expect(readPersistedComposerQueue("user-b")).toEqual([])
  })

  it("rejects queue records owned by another account", () => {
    window.localStorage.setItem(
      "sira:chat-composer-queue:v1:user-a",
      JSON.stringify([queueItem({ ownerId: "user-b" })]),
    )

    expect(readPersistedComposerQueue("user-a")).toEqual([])
  })

  it("refuses excess storage without deleting older accepted tasks", () => {
    const items = Array.from({ length: 50 }, (_, index) => queueItem({
      id: `queue-${index}`,
      msg: `${index}:`.padEnd(64 * 1024, "x"),
      idempotencyKey: `send-${index}`,
    }))

    const accepted = queueItem()
    expect(writePersistedComposerQueue("user-a", [accepted])).toBe(true)
    expect(writePersistedComposerQueue("user-a", items)).toBe(false)
    const raw = window.localStorage.getItem("sira:chat-composer-queue:v1:user-a") || ""
    const restored = readPersistedComposerQueue("user-a")

    expect(raw.length).toBeLessThanOrEqual(512 * 1024)
    expect(restored).toEqual([accepted])
  })

  it("clears every account queue on logout cleanup", () => {
    writePersistedComposerQueue("user-a", [queueItem()])
    writePersistedComposerQueue("user-b", [queueItem({ ownerId: "user-b" })])
    window.localStorage.setItem("unrelated-setting", "keep")

    clearPersistedComposerQueues()

    expect(readPersistedComposerQueue("user-a")).toEqual([])
    expect(readPersistedComposerQueue("user-b")).toEqual([])
    expect(window.localStorage.getItem("unrelated-setting")).toBe("keep")
  })
})


describe("queued message display projection", () => {
  it("shows pending prompts with files and stable identity without changing canonical history", () => {
    const current = [{ id: "answer", role: "ASSISTANT", content: "Trabajando", metadata: {} }]
    const pending = queueItem({ files: [{ id: "file-1", name: "informe.docx" }] })
    const original = JSON.stringify(current)
    const messages = projectQueuedComposerMessages({ items: [pending], ownerId: "user-a", chatId: "chat-a", messages: current })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: pending.id, role: "USER", content: pending.msg, timestamp: pending.createdAt, queued: true, files: pending.files })
    expect(JSON.parse(messages[0].metadata)).toMatchObject({ idempotencyKey: pending.idempotencyKey })
    expect(JSON.stringify(current)).toBe(original)
  })

  it("filters by owner and chat and keeps separate turns with identical text", () => {
    const first = queueItem()
    const second = queueItem({ id: "queue-2", idempotencyKey: "send-2" })
    const items = [first, queueItem({ id: "other-user", ownerId: "user-b" }), second, queueItem({ id: "other-chat", chatId: "chat-b" })]
    expect(projectQueuedComposerMessages({ items, ownerId: "user-a", chatId: "chat-a", messages: [] }).map(message => message.id)).toEqual([first.id, second.id])
    expect(projectQueuedComposerMessages({ items, ownerId: "", chatId: "chat-a", messages: [] })).toEqual([])
  })

  it("reconciles accepted USER turns only by exact identity, not similar text or assistant placeholders", () => {
    const first = queueItem()
    const second = queueItem({ id: "queue-2", idempotencyKey: "send-2" })
    const third = queueItem({ id: "queue-3", idempotencyKey: "send-3" })
    const accepted = [
      { role: "user", content: "edited server text", metadata: JSON.stringify({ idempotencyKey: "send-1" }) },
      { role: "USER", content: "edited server text", metadata: { idempotencyKey: "send-2" } },
      { role: "ASSISTANT", metadata: { idempotencyKey: "send-3" } },
      { role: "USER", content: third.msg, metadata: "not-json" },
    ]
    expect(projectQueuedComposerMessages({ items: [first, second, third], ownerId: "user-a", chatId: "chat-a", messages: accepted }).map(message => message.id)).toEqual([third.id])
  })

  it("shows an unbound prompt only in its matching new conversation", () => {
    const pending = queueItem({ chatId: null })
    expect(projectQueuedComposerMessages({ items: [pending], ownerId: "user-a", chatId: null, messages: [] })).toHaveLength(1)
    expect(projectQueuedComposerMessages({ items: [pending], ownerId: "user-a", chatId: "chat-a", messages: [] })).toEqual([])
  })
})

describe("queue loss prevention", () => {
  beforeEach(() => window.localStorage.clear())

  it("refuses more than fifty items instead of replacing the earliest turn", () => {
    const accepted = Array.from({ length: 50 }, (_, index) => queueItem({ id: `queue-${index}`, idempotencyKey: `send-${index}` }))
    expect(writePersistedComposerQueue("user-a", accepted)).toBe(true)
    expect(writePersistedComposerQueue("user-a", [...accepted, queueItem({ id: "excess" })])).toBe(false)
    expect(readPersistedComposerQueue("user-a")).toEqual(accepted)
  })

  it("keeps safe folder paths across queue persistence without retaining local paths", () => {
    const pending = queueItem({ files: [
      { id: "legal", name: "informe.docx", relativePath: "Documentos/Legal/informe.docx" },
      { id: "admin", name: "informe.docx", relativePath: "Documentos/Administracion/informe.docx" },
      { id: "invalid", name: "informe.docx", relativePath: "../informe.docx" },
      { id: "local", name: "informe.docx", relativePath: "/Users/luis/informe.docx" },
    ] })
    expect(writePersistedComposerQueue("user-a", [pending])).toBe(true)
    const files = readPersistedComposerQueue("user-a")[0].files
    expect(files.map(file => file.relativePath)).toEqual(["Documentos/Legal/informe.docx", "Documentos/Administracion/informe.docx", undefined, undefined])
  })
})


describe("failed queued turns", () => {
  beforeEach(() => window.localStorage.clear())

  it("preserves the failed turn's pause through reload, without blocking other chats", () => {
    const failed = queueItem({ paused: true })
    const next = queueItem({ id: "queue-2", idempotencyKey: "send-2" })
    const elsewhere = queueItem({ id: "queue-b", chatId: "chat-b", idempotencyKey: "send-b" })
    expect(writePersistedComposerQueue("user-a", [failed, next, elsewhere])).toBe(true)
    const restored = readPersistedComposerQueue("user-a")
    expect(restored).toEqual([failed, next, elsewhere])
    expect(isComposerQueueChatPaused(restored, "chat-a")).toBe(true)
    expect(isComposerQueueChatPaused(restored, "chat-b")).toBe(false)
  })

  it("does not resume the failed first turn when a later pending turn is edited or removed", () => {
    const failed = queueItem({ paused: true })
    const later = queueItem({ id: "queue-2", idempotencyKey: "send-2" })
    const items = [failed, later]
    expect(isComposerQueueChatPaused(items.filter(item => item.id !== later.id), "chat-a")).toBe(true)
    expect(isComposerQueueChatPaused(items.filter(item => item.id !== failed.id), "chat-a")).toBe(false)
  })
})
