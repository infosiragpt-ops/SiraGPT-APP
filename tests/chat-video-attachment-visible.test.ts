import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"

const { backfillUserMessageFilesForTranscription } = require(path.join(
  process.cwd(),
  "backend/src/services/message-attachments",
))

import {
  isVideoComposerFile,
  mergeMessageFileLists,
  snapshotComposerFilesForMessage,
} from "../lib/chat/composer-files"
import { parseMessageFilesForRender } from "../lib/chat/message-rendering"
import {
  dedupeMessages,
  mergeChatPreservingUserMessages,
  mergeMessagesPreservingUserContent,
} from "../lib/message-preservation"

const videoFile = {
  id: "file-video-1",
  tempId: "temp-video-1",
  name: "clase.mp4",
  originalName: "clase.mp4",
  type: "video/mp4",
  mimeType: "video/mp4",
  size: 8_388_608,
  url: "/uploads/user/clase.mp4",
  mediaMeta: { durationSeconds: 48 },
  file: { name: "clase.mp4", type: "video/mp4", size: 8_388_608 },
}

describe("optimistic video attachments stay visible", () => {
  it("parseMessageFilesForRender keeps video objects from arrays and JSON", () => {
    assert.equal(parseMessageFilesForRender([videoFile])[0], videoFile)
    const parsed = parseMessageFilesForRender(JSON.stringify([{
      id: "file-video-1",
      name: "clase.mp4",
      mimeType: "video/mp4",
    }]))
    assert.equal(parsed.length, 1)
    assert.equal((parsed[0] as { name: string }).name, "clase.mp4")
    assert.equal((parsed[0] as { mimeType: string }).mimeType, "video/mp4")
  })

  it("snapshotComposerFilesForMessage keeps name, mime and url without the native File", () => {
    const [snapshot] = snapshotComposerFilesForMessage([videoFile])
    assert.equal(snapshot.name, "clase.mp4")
    assert.equal(snapshot.mimeType, "video/mp4")
    assert.equal(snapshot.url, "/uploads/user/clase.mp4")
    assert.equal(snapshot.mediaMeta?.durationSeconds, 48)
    assert.equal("file" in snapshot, false)
    assert.equal(isVideoComposerFile(snapshot), true)
    JSON.stringify(snapshot)
  })

  it("mergeMessageFileLists keeps local preview when the server returns a canonical URL", () => {
    const local = snapshotComposerFilesForMessage([{
      ...videoFile,
      url: "blob:https://siragpt.com/optimistic",
    }])
    const incoming = [{
      id: "file-video-1",
      name: "clase.mp4",
      mimeType: "video/mp4",
      url: "/uploads/user/clase.mp4",
    }]
    const merged = mergeMessageFileLists(incoming, local)
    assert.equal(merged.length, 1)
    const file = merged[0] as {
      url?: string
      mediaMeta?: { durationSeconds?: number }
      name?: string
    }
    assert.equal(file.url, "/uploads/user/clase.mp4")
    assert.equal(file.name, "clase.mp4")
    assert.equal(file.mediaMeta?.durationSeconds, 48)
    assert.equal(isVideoComposerFile(file), true)
  })

  it("preservation does not drop optimistic video files for an empty server payload", () => {
    const local = [
      {
        id: "msg-user-1",
        role: "USER",
        content: "transcribir",
        files: snapshotComposerFilesForMessage([videoFile]),
      },
      { id: "msg-ai-1", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "msg-user-1", role: "USER", content: "transcribir", files: [] },
      { id: "srv-ai-1", role: "ASSISTANT", content: "" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const files = (merged[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 1)
    assert.equal((files[0] as { name?: string }).name, "clase.mp4")
    assert.equal(isVideoComposerFile(files[0]), true)
  })

  it("dedupeMessages grafts video files from the optimistic twin onto the server copy", () => {
    const msgs = [
      {
        id: "msg-user-1700000000000",
        role: "USER",
        content: "transcribir",
        files: snapshotComposerFilesForMessage([videoFile]),
      },
      {
        id: "clx_server_user",
        role: "USER",
        content: "transcribir",
        files: [{ id: "file-video-1" }],
      },
      { id: "msg-assistant-processing-1", role: "ASSISTANT", content: "" },
    ]
    const out = dedupeMessages(msgs)
    const user = out.filter((message) => String(message.role).toUpperCase() === "USER")
    assert.equal(user.length, 1)
    assert.equal(user[0].id, "clx_server_user")
    const files = (user[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 1)
    assert.equal((files[0] as { name?: string }).name, "clase.mp4")
    assert.equal(((files[0] as { mediaMeta?: { durationSeconds?: number } }).mediaMeta)?.durationSeconds, 48)
  })
})

describe("transcription backfill keeps video on the persisted user turn", () => {
  const videoRow = {
    id: "file-video-1",
    filename: "clase.mp4",
    originalName: "clase.mp4",
    mimeType: "video/mp4",
    size: 8_388_608,
    extractedText: "Transcripción local — 10 caracteres, modelo: ggml-base.bin, idioma: es\n---\nhola mundo",
    openaiFileId: null,
  }

  const makePrisma = (userFiles: unknown) => {
    const updates: Array<{ id: string; files: unknown }> = []
    const prisma = {
      file: {
        async findMany() {
          return [videoRow]
        },
      },
      message: {
        async findFirst() {
          return {
            id: "msg-user-db-1",
            role: "USER",
            content: "transcribir",
            files: userFiles,
          }
        },
        async update({ where, data }: { where: { id: string }; data: { files: unknown } }) {
          updates.push({ id: where.id, files: data.files })
          return { id: where.id, ...data }
        },
      },
    }
    return { prisma, updates }
  }

  const baseArgs = {
    chatId: "chat-1",
    userId: "user-1",
    taskId: "task-1",
    fileIds: ["file-video-1"],
    clientMetadata: [{ id: "file-video-1", name: "clase.mp4", mimeType: "video/mp4" }],
  }

  it("writes resolved video files onto a user turn stored with files null", async () => {
    const { prisma, updates } = makePrisma(null)
    const written = await backfillUserMessageFilesForTranscription(prisma as any, baseArgs)
    assert.equal(written, true)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].id, "msg-user-db-1")
    const files = updates[0].files as Array<{ name?: string; mimeType?: string; url?: string }>
    assert.equal(files.length, 1)
    assert.equal(files[0].name, "clase.mp4")
    assert.equal(files[0].mimeType, "video/mp4")
    assert.equal(files[0].url, "/uploads/user-1/clase.mp4")
    assert.equal(isVideoComposerFile(files[0]), true)
  })

  it("writes onto a user turn stored with an empty files array", async () => {
    const { prisma, updates } = makePrisma([])
    const written = await backfillUserMessageFilesForTranscription(prisma as any, baseArgs)
    assert.equal(written, true)
    assert.equal(updates.length, 1)
  })

  it("never overwrites a user turn that already carries files", async () => {
    const { prisma, updates } = makePrisma([{ id: "file-video-1", name: "clase.mp4" }])
    const written = await backfillUserMessageFilesForTranscription(prisma as any, baseArgs)
    assert.equal(written, false)
    assert.equal(updates.length, 0)
  })

  it("is a no-op without resolved file ids", async () => {
    const { prisma, updates } = makePrisma(null)
    const written = await backfillUserMessageFilesForTranscription(prisma as any, {
      ...baseArgs,
      fileIds: [],
    })
    assert.equal(written, false)
    assert.equal(updates.length, 0)
  })
})

describe("mergeChatPreservingUserMessages adopts temp-chat video onto a real id", () => {
  it("merges temp-chat USER + video onto an empty real incoming chat", () => {
    const local = {
      id: "temp-chat-1700000000000",
      title: "transcribir",
      messages: [
        {
          id: "msg-user-1",
          role: "USER",
          content: "transcribir",
          files: snapshotComposerFilesForMessage([videoFile]),
        },
      ],
    }
    const incoming = {
      id: "clx_real_chat",
      title: "Nuevo chat",
      messages: [],
    }
    const merged = mergeChatPreservingUserMessages(incoming as any, local as any)
    assert.equal(merged.id, "clx_real_chat")
    const users = (merged.messages || []).filter(
      (message: { role?: string }) => String(message.role).toUpperCase() === "USER",
    )
    assert.equal(users.length, 1)
    const files = (users[0] as { files?: unknown[] }).files || []
    assert.equal(files.length, 1)
    assert.equal(isVideoComposerFile(files[0]), true)
  })
})
