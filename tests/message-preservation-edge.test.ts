import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  mergeMessagesPreservingUserContent,
  preserveOrphanAssistantMessages,
} from "../lib/message-preservation"

/**
 * Edge cases for the message-merge passes. The big picture is already
 * covered by `message-preservation.test.ts` (Pass 1) and
 * `message-preservation-orphans.test.ts` (Pass 2 + Pass 3). This
 * suite hits the rarer corners that bit us in the past or look
 * fragile in the diff:
 *
 *   1. Empty inputs (both / either side empty)
 *   2. Pass 1b: assistant content collision when ordinals don't line up
 *   3. Pass 3 directly (preserveOrphanAssistantMessages)
 *   4. Files merging — id-only server payloads vs rich local files
 */
describe("merge · edge inputs", () => {
  it("returns [] when both sides are empty", () => {
    assert.deepEqual(
      mergeMessagesPreservingUserContent([], []),
      [],
    )
  })

  it("returns the incoming list unchanged when local is empty", () => {
    const incoming = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "hola, ¿cómo te ayudo?" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, [])
    assert.deepEqual(merged, incoming)
  })

  it("returns the local user messages when incoming has only assistants", () => {
    const local = [
      { id: "u1", role: "USER", content: "ping" },
    ]
    const incoming = [
      { id: "a1", role: "ASSISTANT", content: "pong" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    // Pass 2 should re-insert the user turn so the timeline reads
    // user → assistant the way the user saw it.
    const userCount = merged.filter((m) => String(m.role).toUpperCase() === "USER").length
    assert.equal(userCount, 1)
    assert.equal(merged.length, 2)
  })
})

describe("merge · Pass 1b — assistant content collisions", () => {
  it("does NOT clobber server assistant content when local has the same id but is empty", () => {
    const local = [
      { id: "u1", role: "USER", content: "resume" },
      { id: "msg-ai-1", role: "ASSISTANT", content: "" }, // optimistic placeholder
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "resume" },
      { id: "msg-ai-1", role: "ASSISTANT", content: "El documento concluye que…" },
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged[1].content, "El documento concluye que…")
  })

  it("preserves local assistant content even when ordinals differ from incoming", () => {
    // Local has 2 assistants, server returned 1 with a different id.
    // Pass 1b matches by ordinal: incoming[0] should keep the local
    // content of localAssistants[0].
    const local = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "msg-ai-old", role: "ASSISTANT", content: "Hola, ¿cómo te ayudo?" },
    ]
    const incoming = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "asst-srv-new", role: "ASSISTANT", content: "" }, // server lagging
    ]
    const merged = mergeMessagesPreservingUserContent(incoming, local)
    assert.equal(merged[1].id, "asst-srv-new")
    assert.equal(merged[1].content, "Hola, ¿cómo te ayudo?")
  })
})

describe("preserveOrphanAssistantMessages", () => {
  it("returns the enriched list verbatim when there are no local orphans", () => {
    const local = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
    ]
    const enriched = [
      { id: "u1", role: "USER", content: "hola" },
      { id: "a1", role: "ASSISTANT", content: "Hola" },
    ]
    const result = preserveOrphanAssistantMessages(enriched, local)
    assert.deepEqual(result, enriched)
  })

  it("appends only the trailing local orphan, never older ones", () => {
    // Local: 3 assistants. Server returned 2. The orphan is the 3rd
    // (most recent). We should NOT re-insert assistant #1 or #2 if
    // they're already in the server response.
    const local = [
      { id: "u1", role: "USER", content: "hi" },
      { id: "a1", role: "ASSISTANT", content: "Hi 1" },
      { id: "a2", role: "ASSISTANT", content: "Hi 2" },
      { id: "a3", role: "ASSISTANT", content: "Hi 3 (orphan)" },
    ]
    const enriched = [
      { id: "u1", role: "USER", content: "hi" },
      { id: "a1", role: "ASSISTANT", content: "Hi 1" },
      { id: "a2", role: "ASSISTANT", content: "Hi 2" },
    ]
    const result = preserveOrphanAssistantMessages(enriched, local)
    assert.equal(result.length, 4)
    assert.equal(result[3].id, "a3")
    assert.equal(result[3].content, "Hi 3 (orphan)")
  })

  it("skips an orphan whose id already exists in enriched (paranoid dedupe)", () => {
    const local = [
      { id: "a1", role: "ASSISTANT", content: "duplicate" },
    ]
    const enriched = [
      { id: "a1", role: "ASSISTANT", content: "duplicate" },
    ]
    const result = preserveOrphanAssistantMessages(enriched, local)
    assert.equal(result.length, 1)
  })

  it("preserves a tail orphan with files but no content (e.g. artifact-only message)", () => {
    const local = [
      { id: "u1", role: "USER", content: "make a chart" },
      {
        id: "a-art",
        role: "ASSISTANT",
        content: "",
        files: [{ id: "chart-1", name: "chart.png", url: "/blob/c" }],
      },
    ]
    const enriched = [
      { id: "u1", role: "USER", content: "make a chart" },
    ]
    const result = preserveOrphanAssistantMessages(enriched, local)
    assert.equal(result.length, 2)
    assert.deepEqual(
      (result[1] as { files?: unknown[] }).files,
      [{ id: "chart-1", name: "chart.png", url: "/blob/c" }],
    )
  })
})
