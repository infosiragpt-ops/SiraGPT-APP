import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { mergeChatPreservingUserMessages, preserveOrphanAssistantMessages } from "../lib/message-preservation"

/**
 * Regression for the blank "Generando · 16:9" card that stayed under a
 * generated image forever.
 *
 * In an existing chat the send flow appends an optimistic USER turn plus an
 * EMPTY assistant landing bubble, and the image handler appends its own
 * `[GENERATING_IMAGE]` card. When the backend answered, the reload merged
 * server rows [img1, img2] with local [img1, '', [GENERATING_IMAGE]]: the
 * positional orphan pass kept the surplus local card and rendered it under
 * the real image as a second, never-resolving generation.
 */
describe("transient placeholders never survive a fresh server assistant row", () => {
  const img1 = { id: "asst_img_1", role: "ASSISTANT", content: "https://cdn/img1.png", files: JSON.stringify([{ type: "image", url: "https://cdn/img1.png" }]) }
  const user1 = { id: "user_1", role: "USER", content: "créame un pájaro cantando un colibrí" }
  const user2Local = { id: "msg-user-1700000002000", role: "USER", content: "quiero que la imagen del colibrí sea horizontal", metadata: JSON.stringify({ idempotencyKey: "k2" }) }
  const user2Server = { id: "user_2", role: "USER", content: "quiero que la imagen del colibrí sea horizontal" }
  const landing = { id: "msg-assistant-processing-1700000002001", role: "ASSISTANT", content: "", metadata: JSON.stringify({ idempotencyKey: "k2" }) }
  const generating = { id: "msg-assistant-generating-1700000002002", role: "ASSISTANT", content: "[GENERATING_IMAGE]", metadata: JSON.stringify({ aspectRatio: "16:9", imageCount: 1 }) }
  const img2 = { id: "asst_img_2", role: "ASSISTANT", content: "https://cdn/img2.png", files: JSON.stringify([{ type: "image", url: "https://cdn/img2.png" }]) }

  it("drops the [GENERATING_IMAGE] card once the server delivered the new image (the reported bug shape)", () => {
    const local = { id: "chat_1", messages: [user1, img1, user2Local, landing, generating] }
    const incoming = { id: "chat_1", messages: [user1, img1, user2Server, img2] }
    const merged = mergeChatPreservingUserMessages(incoming, local)
    const contents = merged.messages!.map((m) => m.content)
    assert.ok(!contents.includes("[GENERATING_IMAGE]"), `phantom card survived: ${JSON.stringify(contents)}`)
    const assistants = merged.messages!.filter((m) => String(m.role).toUpperCase() === "ASSISTANT")
    assert.equal(assistants.length, 2, "exactly the two real images")
    assert.equal(assistants[1].id, "asst_img_2")
  })

  it("keeps the placeholder while the server has not answered yet (no fresh assistant row)", () => {
    // Reload racing the generation: server still only has the older turn.
    const local = [user1, img1, user2Local, generating]
    const incoming = [user1, img1, user2Server]
    const merged = preserveOrphanAssistantMessages(incoming, local)
    assert.ok(merged.some((m) => m.content === "[GENERATING_IMAGE]"), "the live card must stay until the image lands")
  })

  it("does not treat an assistant row local already knew as 'fresh'", () => {
    // Same id on both sides → nothing new arrived → keep the live card.
    const local = [user1, img1, generating]
    const incoming = [user1, img1]
    const merged = preserveOrphanAssistantMessages(incoming, local)
    assert.ok(merged.some((m) => m.content === "[GENERATING_IMAGE]"))
  })

  it("applies to every client-only progress sentinel, not only images", () => {
    for (const sentinel of ["[GENERATING_PPT]", "[GENERATING_VECTOR_PPT]", "[PROCESSING_GMAIL]", "[PROCESSING_DRIVE_ACTION]", "[THESIS_GENERATING]"]) {
      const card = { id: `msg-assistant-x-${sentinel}`, role: "ASSISTANT", content: sentinel }
      const local = [user1, img1, user2Local, card]
      const incoming = [user1, img1, user2Server, { id: "asst_new", role: "ASSISTANT", content: "Listo, aquí tienes el resultado." }]
      const merged = preserveOrphanAssistantMessages(incoming, local)
      assert.ok(!merged.some((m) => m.content === sentinel), `${sentinel} must not outlive the real answer`)
    }
  })

  it("still preserves a real orphan assistant answer (the stream-completion race)", () => {
    const answer = { id: "msg-ai-1700000003000", role: "ASSISTANT", content: "Aquí está la respuesta completa que el servidor aún no persistió." }
    const local = [user1, img1, user2Local, answer]
    const incoming = [user1, img1, user2Server]
    const merged = preserveOrphanAssistantMessages(incoming, local)
    assert.ok(merged.some((m) => m.id === "msg-ai-1700000003000"))
  })
})
