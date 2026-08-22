import { describe, it, expect, beforeEach } from "vitest"
import {
  readDocumentDraft,
  writeDocumentDraft,
  clearDocumentDraft,
  type DocumentDraft,
} from "../../lib/chat/document-draft"

// Minimal localStorage stand-in; the module guards on `typeof window` so we
// install a global before exercising the accessors.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

describe("document-draft (localStorage resilience)", () => {
  beforeEach(() => {
    ;(globalThis as { window?: unknown }).window = { localStorage: new MemoryStorage() }
  })

  const draft: DocumentDraft = {
    content: "# Borrador\n\nedición en curso",
    savedAt: 1_755_000_000_000,
    baseVersion: 3,
  }

  it("round-trips a draft per (userId, fileId)", () => {
    expect(readDocumentDraft("f1", "u1")).toBe(null)
    expect(writeDocumentDraft("f1", draft, "u1")).toBe(draft.savedAt)
    expect(readDocumentDraft("f1", "u1")).toEqual(draft)

    // Different user or file never sees the other's draft.
    expect(readDocumentDraft("f1", "u2")).toBe(null)
    expect(readDocumentDraft("f2", "u1")).toBe(null)

    clearDocumentDraft("f1", "u1")
    expect(readDocumentDraft("f1", "u1")).toBe(null)
  })

  it("repairs malformed payloads instead of throwing", () => {
    const store = (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window.localStorage
    store.setItem("sira:doc-draft:u1:f9", "{not json")
    expect(readDocumentDraft("f9", "u1")).toBe(null)

    store.setItem("sira:doc-draft:u1:f9", JSON.stringify({ savedAt: 123 }))
    expect(readDocumentDraft("f9", "u1")).toBe(null)

    // Missing baseVersion falls back to 0.
    store.setItem("sira:doc-draft:u1:f9", JSON.stringify({ content: "hola", savedAt: 5 }))
    const got = readDocumentDraft("f9", "u1")
    expect(got).not.toBe(null)
    expect(got!.baseVersion).toBe(0)
    expect(got!.content).toBe("hola")
  })

  it("refuses oversized drafts and SSR/no-window calls", () => {
    expect(writeDocumentDraft("big", { ...draft, content: "x".repeat(1_000_001) }, "u1")).toBe(null)
    expect(writeDocumentDraft("", draft, "u1")).toBe(null)
    expect(readDocumentDraft("", "u1")).toBe(null)

    const hadWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = undefined
    expect(readDocumentDraft("f1", "u1")).toBe(null)
    expect(writeDocumentDraft("f1", draft, "u1")).toBe(null)
    expect(() => clearDocumentDraft("f1", "u1")).not.toThrow()
    ;(globalThis as { window?: unknown }).window = hadWindow
  })
})
