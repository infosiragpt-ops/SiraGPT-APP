import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  mergeMessagesPreservingUserContent,
  mergeChatPreservingUserMessages,
} from "../lib/message-preservation"

/**
 * Regression test for the "user message disappears after assistant
 * responds" bug reported with the transcribe-image flow:
 *
 *   1. User uploads an image and types "transcrinir".
 *   2. Frontend optimistically shows the user turn with a temp id
 *      `msg-user-<ts>`.
 *   3. Assistant responds and the chat is refreshed from the server.
 *   4. Server response (for whatever reason: race, partial save,
 *      transcription pipeline replacing the turn) does NOT include
 *      the user message.
 *   5. Old merge logic only iterated over the incoming list, so the
 *      local user message was silently dropped from the UI.
 *
 * The new contract: a user message that the user already SAW must
 * never disappear. mergeMessagesPreservingUserContent re-inserts any
 * orphaned local user message before the assistant message that
 * followed it locally.
 */
describe("mergeMessagesPreservingUserContent - never drops local user messages", () => {
  it("re-inserts a user message that the server omitted (the transcribe bug)", () => {
    const local = [
      { id: "asst_seed", role: "ASSISTANT", content: "Hola, en que te ayudo?" },
      {
        id: "msg-user-1700000000000",
        role: "USER",
        content: "transcrinir",
        files: [{ id: "f1", name: "screenshot.png" }],
      },
      { id: "msg-ai-1700000001000", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "asst_seed", role: "ASSISTANT", content: "Hola, en que te ayudo?" },
      // Server skipped the user turn entirely
      {
        id: "asst_real",
        role: "ASSISTANT",
        content: "El contenido transcrito de la imagen es: LAS NORMAS A USAR SON VANCOUVER",
      },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)

    const userMessages = merged.filter(m => String(m.role).toUpperCase() === "USER")
    assert.equal(userMessages.length, 1, "user message must survive the merge")
    assert.equal(userMessages[0].content, "transcrinir")
    // It should appear BEFORE the new assistant message it triggered.
    const userIdx = merged.findIndex(m => String(m.role).toUpperCase() === "USER")
    const asstIdx = merged.findIndex(m => (m as any).id === "asst_real")
    assert.ok(userIdx < asstIdx, "preserved user message must precede the assistant reply")
  })

  it("does not duplicate when the server DOES include the user message", () => {
    const local = [
      {
        id: "msg-user-1700000000000",
        role: "USER",
        content: "transcribir esto",
      },
      { id: "msg-ai-1700000001000", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "real_user_id", role: "USER", content: "transcribir esto" },
      { id: "real_asst_id", role: "ASSISTANT", content: "Aqui esta la transcripcion..." },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)

    const userMessages = merged.filter(m => String(m.role).toUpperCase() === "USER")
    assert.equal(userMessages.length, 1, "must not duplicate when content matches")
  })

  it("does not duplicate when matching by stable server id", () => {
    const local = [
      { id: "real_user_id", role: "USER", content: "anything" },
      { id: "msg-ai-1700000001000", role: "ASSISTANT", content: "stub" },
    ]
    const incoming = [
      { id: "real_user_id", role: "USER", content: "" },  // server returned empty
      { id: "real_asst_id", role: "ASSISTANT", content: "answer" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const users = merged.filter(m => String(m.role).toUpperCase() === "USER")
    assert.equal(users.length, 1)
    // Content was preserved from local (existing behavior)
    assert.equal(users[0].content, "anything")
  })

  it("inserts orphan at end if no later assistant message exists locally", () => {
    const local = [
      { id: "msg-user-late", role: "USER", content: "late message" },
    ]
    const incoming: any[] = []
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].content, "late message")
  })

  it("preserves files of orphan user message", () => {
    const local = [
      {
        id: "msg-user-1700000000000",
        role: "USER",
        content: "explain this",
        files: [{ id: "f1", name: "diagram.png" }],
      },
      { id: "msg-ai-1700000001000", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "asst_real", role: "ASSISTANT", content: "Here's the explanation..." },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const u = merged.find(m => String(m.role).toUpperCase() === "USER") as any
    assert.ok(u, "user message present")
    assert.ok(Array.isArray(u.files) && u.files.length === 1, "files preserved")
  })

  it("keeps rich upload metadata when the server refresh returns only file ids", () => {
    const local: any[] = [
      {
        id: "real_user_id",
        role: "USER",
        content: "transcribir porfavor",
        files: [
          {
            id: "img_1",
            name: "captura.png",
            type: "image/png",
            url: "/uploads/user/captura.png",
            extractedText: "LAS NORMAS A USAR SON VANCOUVER",
          },
          {
            id: "doc_1",
            name: "documento-prueba.docx",
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            url: "/uploads/user/documento-prueba.docx",
            extractedText: "ALFA es la primera palabra real.",
          },
        ],
      },
      { id: "asst_real", role: "ASSISTANT", content: "stub" },
    ]
    const incoming: any[] = [
      {
        id: "real_user_id",
        role: "USER",
        content: "transcribir porfavor",
        files: ["img_1", "doc_1"],
      },
      { id: "asst_real", role: "ASSISTANT", content: "answer" },
    ]

    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const u = merged.find(m => String(m.role).toUpperCase() === "USER") as any

    assert.equal(u.files[0].name, "captura.png")
    assert.equal(u.files[0].type, "image/png")
    assert.equal(u.files[1].name, "documento-prueba.docx")
    assert.match(u.files[1].extractedText, /ALFA/)
  })

  it("handles multiple orphans in correct order", () => {
    const local = [
      { id: "msg-user-1", role: "USER", content: "first question" },
      { id: "asst-1", role: "ASSISTANT", content: "first answer" },
      { id: "msg-user-2", role: "USER", content: "second question" },
      { id: "msg-ai-2", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "asst-1", role: "ASSISTANT", content: "first answer" },
      { id: "asst-2", role: "ASSISTANT", content: "second answer" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const users = merged.filter(m => String(m.role).toUpperCase() === "USER")
    assert.equal(users.length, 2)
    assert.equal(users[0].content, "first question")
    assert.equal(users[1].content, "second question")
  })

  it("text NEVER shrinks to empty when server returns same id with content=''", () => {
    // The "transcirbir" regression: user uploads image + types short text.
    // Server returns the user turn with content="" (vision pipeline rewrote
    // the row). Old merge wrote "" over local content because the explicit
    // emptiness check only handled null/undefined, not stale equal-length
    // empty strings paired by ordinal.
    const local = [
      { id: "real_user_id", role: "USER", content: "transcirbir", files: [{ id: "f1" }] },
      { id: "asst_real", role: "ASSISTANT", content: "stub" },
    ]
    const incoming = [
      { id: "real_user_id", role: "USER", content: "", files: [{ id: "f1" }] },
      { id: "asst_real", role: "ASSISTANT", content: "answer" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const u = merged.find(m => String(m.role).toUpperCase() === "USER") as any
    assert.equal(u.content, "transcirbir", "user text must not shrink to empty")
  })

  it("longer local content wins over shorter incoming for the same user turn", () => {
    const local = [
      { id: "u1", role: "USER", content: "explica este screenshot por favor" },
      { id: "asst", role: "ASSISTANT", content: "answer" },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "explica" },
      { id: "asst", role: "ASSISTANT", content: "answer" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const u = merged.find(m => String(m.role).toUpperCase() === "USER") as any
    assert.equal(u.content, "explica este screenshot por favor", "longer local must win")
  })

  it("matches local user message by content when no id alignment is possible", () => {
    const local: any[] = [
      { id: "msg-user-temp", role: "USER", content: "hola", files: [{ id: "f1" }] },
    ]
    const incoming: any[] = [
      { id: "u-real", role: "USER", content: "hola", files: undefined },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    const u = merged.find(m => String(m.role).toUpperCase() === "USER") as any
    assert.equal(u.content, "hola")
    assert.ok(Array.isArray(u.files) && u.files.length === 1, "files recovered via content match")
  })

  it("mergeChatPreservingUserMessages preserves orphans on full chat object", () => {
    const local = {
      id: "chat_1",
      messages: [
        { id: "msg-user-1700000000000", role: "USER", content: "user turn" },
        { id: "msg-ai-1700000001000", role: "ASSISTANT", content: "" },
      ],
    }
    const incoming = {
      id: "chat_1",
      messages: [{ id: "asst_real", role: "ASSISTANT", content: "answer only" }],
    }
    const merged = mergeChatPreservingUserMessages(incoming, local)
    const userCount = merged.messages!.filter(m =>
      String((m as any).role).toUpperCase() === "USER"
    ).length
    assert.equal(userCount, 1)
  })
})

/**
 * Pass 1b - regression suite for the "answer flashes for ~2 s then
 * disappears" bug. After the assistant stream finishes, the client
 * calls `selectChat()` to refresh from the server. If the backend
 * hasn't yet persisted the just-completed assistant turn, the server
 * payload arrives with `content=""` (or omits the message). Without
 * Pass 1b, the merge replaces the local rich content with the empty
 * server copy and the bubble vanishes.
 */
describe("mergeMessagesPreservingUserContent - assistant content / orphan preservation", () => {
  it("keeps local assistant content when the server echoes the same turn with empty body", () => {
    const local = [
      { id: "msg-user-1", role: "USER", content: "resume el doc" },
      { id: "msg-ai-1", role: "ASSISTANT", content: "El documento concluye que…" },
    ]
    const incoming = [
      { id: "msg-user-1", role: "USER", content: "resume el doc" },
      // Server echoes the same id but content is still ""
      { id: "msg-ai-1", role: "ASSISTANT", content: "" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged[1].content, "El documento concluye que…")
  })

  it("does NOT overwrite valid server assistant content with local stub", () => {
    const local = [
      { id: "msg-user-1", role: "USER", content: "ping" },
      { id: "msg-ai-1", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "msg-user-1", role: "USER", content: "ping" },
      { id: "msg-ai-1", role: "ASSISTANT", content: "Final server answer" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged[1].content, "Final server answer")
  })

  it("preserves rich file metadata on assistant turn when server returns ids only", () => {
    const local = [
      { id: "u1", role: "USER", content: "genera grafico" },
      {
        id: "a1",
        role: "ASSISTANT",
        content: "Listo",
        files: [{ id: "art_1", name: "chart.png", url: "/blob/x", mimeType: "image/png" }],
      },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "genera grafico" },
      // Server reply only carries the id, not the rich metadata
      { id: "a1", role: "ASSISTANT", content: "Listo", files: [{ id: "art_1" }] },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.deepEqual(merged[1].files, [
      { id: "art_1", name: "chart.png", url: "/blob/x", mimeType: "image/png" },
    ])
  })

  it("Pass 3 - re-appends local orphan assistant tail the server hasn't persisted yet", () => {
    const local = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a-srv-1", role: "ASSISTANT", content: "Hola, ¿cómo te ayudo?" },
      { id: "u2", role: "USER", content: "resume el pdf" },
      { id: "a-tail", role: "ASSISTANT", content: "El documento explica…" },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a-srv-1", role: "ASSISTANT", content: "Hola, ¿cómo te ayudo?" },
      { id: "u2", role: "USER", content: "resume el pdf" },
      // Server hasn't saved a-tail yet
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged.length, 4)
    assert.equal(merged[3].id, "a-tail")
    assert.equal(merged[3].content, "El documento explica…")
  })

  it("Pass 3 does NOT duplicate when server has caught up", () => {
    const local = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged.length, 2)
  })

  it("Pass 3 skips empty local assistant stubs (no content, no files)", () => {
    const local = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
      { id: "a-stub", role: "ASSISTANT", content: "" },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    // The empty stub is NOT worth preserving — next refresh will surface real content.
    assert.equal(merged.length, 2)
  })
})
