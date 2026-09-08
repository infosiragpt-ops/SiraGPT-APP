import { beforeEach, describe, expect, it } from "vitest"

import {
  clearPersistedComposerQueues,
  createPersistedComposerQueueItem,
  readPersistedComposerQueue,
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
      Array.from({ length: 40 }, (_, index) => ({ fileId: `upload-${index}`, name: `file-${index}.txt` })),
    )

    expect(serialized).toHaveLength(24)
    expect(serialized.at(-1)?.fileId).toBe("upload-23")
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

  it("bounds localStorage use and keeps the newest queued tasks", () => {
    const items = Array.from({ length: 50 }, (_, index) => queueItem({
      id: `queue-${index}`,
      msg: `${index}:`.padEnd(64 * 1024, "x"),
      idempotencyKey: `send-${index}`,
    }))

    expect(writePersistedComposerQueue("user-a", items)).toBe(true)
    const raw = window.localStorage.getItem("sira:chat-composer-queue:v1:user-a") || ""
    const restored = readPersistedComposerQueue("user-a")

    expect(raw.length).toBeLessThanOrEqual(512 * 1024)
    expect(restored.length).toBeLessThan(50)
    expect(restored.at(-1)?.id).toBe("queue-49")
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
