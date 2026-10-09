import { describe, expect, it, vi } from "vitest"
import { createModelSelectionWriter } from "@/lib/chat/model-selection-writer"
import { reconcileSelectedCatalogModel } from "@/lib/chat/catalog-model"

describe("selected model persistence", () => {
  it("preserves an unavailable choice instead of selecting the first funded model", () => {
    expect(reconcileSelectedCatalogModel([{ name: "deepseek-v4-flash", provider: "DeepSeek" }], "gpt-5", "OpenAI"))
      .toEqual({ name: "gpt-5", provider: "OpenAI" })
  })
  it("serializes A then B and only settles the latest choice", async () => {
    let release!: () => void
    const aGate = new Promise<void>(resolve => { release = resolve })
    const persist = vi.fn(async (value: string) => { if (value === "A") await aGate })
    const confirmed = vi.fn()
    const failed = vi.fn()
    const write = createModelSelectionWriter<string>()
    const a = write({ scope: "chat", previous: "original", next: "A", persist, confirmed, failed })
    const b = write({ scope: "chat", previous: "A", next: "B", persist, confirmed, failed })
    await Promise.resolve()
    expect(persist.mock.calls.map(([v]) => v)).toEqual(["A"])
    release()
    await Promise.all([a, b])
    expect(persist.mock.calls.map(([v]) => v)).toEqual(["A", "B"])
    expect(confirmed.mock.calls).toEqual([["B"]])
    expect(failed).not.toHaveBeenCalled()
  })
  it("rolls a failed last choice back to the last successfully persisted one", async () => {
    const write = createModelSelectionWriter<string>()
    const failed = vi.fn()
    const confirmed = vi.fn()
    const persist = async (value: string) => { if (value === "B") throw new Error("offline") }
    await write({ scope: "chat", previous: "original", next: "A", persist, confirmed, failed })
    expect(await write({ scope: "chat", previous: "A", next: "B", persist, confirmed, failed })).toBe(false)
    expect(failed).toHaveBeenCalledWith("A")
  })
  it("uses the reopened chat's confirmed selection, not stale writer history", async () => {
    const write = createModelSelectionWriter<string>()
    const failed = vi.fn(), confirmed = vi.fn()
    await write({ scope: "chat", previous: "original", next: "A", persist: async () => {}, confirmed, failed })
    await write({ scope: "chat", previous: "external-new-choice", next: "B", persist: async () => { throw new Error("offline") }, confirmed, failed })
    expect(failed).toHaveBeenCalledWith("external-new-choice")
  })
})
