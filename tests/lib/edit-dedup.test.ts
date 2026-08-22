import { describe, it, expect } from "vitest"
import {
  MAX_CLIENT_MUTATION_ID_LEN,
  normalizeClientMutationId,
  hashDocumentContent,
  buildEditDedupKey,
  classifyEditReplay,
} from "../../backend/src/services/document-editing/edit-dedup"

describe("edit-dedup (autosave idempotency)", () => {
  it("normalizes clientMutationId and rejects unusable ones", () => {
    expect(normalizeClientMutationId("  edit-abc-123  ")).toBe("edit-abc-123")
    expect(normalizeClientMutationId(undefined)).toBe(null)
    expect(normalizeClientMutationId(null)).toBe(null)
    expect(normalizeClientMutationId(42 as unknown as string)).toBe(null)
    expect(normalizeClientMutationId("")).toBe(null)
    expect(normalizeClientMutationId("   ")).toBe(null)
    expect(normalizeClientMutationId("a".repeat(MAX_CLIENT_MUTATION_ID_LEN + 1))).toBe(null)
    expect(normalizeClientMutationId("a".repeat(MAX_CLIENT_MUTATION_ID_LEN))).toBe(
      "a".repeat(MAX_CLIENT_MUTATION_ID_LEN),
    )
    // Control characters and exotic unicode are refused.
    expect(normalizeClientMutationId("bad\u0000id")).toBe(null)
    expect(normalizeClientMutationId("malñ🚀id")).toBe(null)
  })

  it("hashes content deterministically and refuses non-strings", () => {
    const h1 = hashDocumentContent("# Hola\n\nmundo")
    const h2 = hashDocumentContent("# Hola\n\nmundo")
    const h3 = hashDocumentContent("# Hola\n\nmundox")
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(hashDocumentContent(undefined as unknown as string)).toBe(null)
    expect(hashDocumentContent(null as unknown as string)).toBe(null)
  })

  it("scopes the dedup key by user and file", () => {
    const key = buildEditDedupKey("file-1", "user-9", "mut-1")
    expect(key).toMatch(/^file-edit:user-9:file-1:mut-1$/)
    expect(key).not.toBe(buildEditDedupKey("file-2", "user-9", "mut-1"))
    expect(key).not.toBe(buildEditDedupKey("file-1", "user-8", "mut-1"))
  })

  it("classifies replay only for same id + same content with a version snapshot", () => {
    const version = { id: "v2", version: 2 }
    const record = { contentHash: hashDocumentContent("contenido"), version }

    expect(classifyEditReplay(null, "x")).toEqual({ action: "create" })
    expect(classifyEditReplay(undefined, "x")).toEqual({ action: "create" })

    const same = classifyEditReplay(record, hashDocumentContent("contenido"))
    expect(same.action).toBe("replay")
    expect((same as { existingVersion?: unknown }).existingVersion).toBe(version)

    // Same id, different content → conflict, never a silent wrong replay.
    expect(classifyEditReplay(record, hashDocumentContent("OTRO contenido")).action).toBe("conflict")

    // Record without a usable hash is a conflict; without a snapshot, create.
    expect(classifyEditReplay({ version }, hashDocumentContent("contenido")).action).toBe("conflict")
    expect(classifyEditReplay({ contentHash: "deadbeef", version }, hashDocumentContent("contenido")).action).toBe(
      "conflict",
    )
    expect(classifyEditReplay({ contentHash: "deadbeef" }, hashDocumentContent("contenido")).action).toBe(
      "conflict",
    )
    expect(
      classifyEditReplay(
        { contentHash: hashDocumentContent("contenido"), version: null },
        hashDocumentContent("contenido"),
      ).action,
    ).toBe("create")
  })
})
