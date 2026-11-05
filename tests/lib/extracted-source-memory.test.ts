import { describe, expect, it } from "vitest"

import {
  EXTRACTED_SOURCE_MAX,
  EXTRACTED_SOURCE_TTL_MS,
  createExtractedSourceMemory,
  sourceFingerprint,
} from "@/lib/media/extracted-source-memory"

/**
 * The videos whose audio alone was uploaded: attaching the same file again
 * (same name, size and date) uploads it whole. Remembered for 24 h, capped,
 * and still remembered for the tab when storage is blocked.
 */

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string) { this.data.set(key, String(value)) }
  removeItem(key: string) { this.data.delete(key) }
}

const video = (name: string, size = 900, lastModified = 1_700_000_000_000) => ({ name, size, lastModified })

describe("extracted source memory", () => {
  it("fingerprints the same file picked again, never an empty or unsized one", () => {
    expect(sourceFingerprint(video("Clase.mp4"))).toBe("Clase.mp4|900|1700000000000")
    expect(sourceFingerprint({ name: "", size: 9 })).toBeNull()
    expect(sourceFingerprint({ name: "x.mp4", size: 0 })).toBeNull()
    expect(sourceFingerprint(null)).toBeNull()
  })

  it("remembers across instances that share the storage, and forgets after 24 h", () => {
    const storage = new MemoryStorage()
    let now = 1_000
    const first = createExtractedSourceMemory({ storage: () => storage as unknown as Storage, now: () => now })
    first.remember(video("Clase.mp4"))
    expect(first.has(video("Clase.mp4"))).toBe(true)
    expect(first.has(video("Clase.mp4", 901))).toBe(false)
    const reloaded = createExtractedSourceMemory({ storage: () => storage as unknown as Storage, now: () => now })
    expect(reloaded.has(video("Clase.mp4"))).toBe(true)
    now += EXTRACTED_SOURCE_TTL_MS
    expect(reloaded.has(video("Clase.mp4"))).toBe(false)
    expect(first.has(video("Clase.mp4"))).toBe(false)
  })

  it("keeps the newest entries within the cap and survives corrupt storage", () => {
    const storage = new MemoryStorage()
    let now = 0
    const memory = createExtractedSourceMemory({ storage: () => storage as unknown as Storage, now: () => now })
    for (let i = 0; i < EXTRACTED_SOURCE_MAX + 5; i += 1) { now += 1; memory.remember(video(`v${i}.mp4`)) }
    const stored = JSON.parse(storage.getItem("sira.extracted-sources.v1")!)
    expect(Object.keys(stored)).toHaveLength(EXTRACTED_SOURCE_MAX)
    expect(Object.keys(stored)).not.toContain("v0.mp4|900|1700000000000")
    storage.setItem("sira.extracted-sources.v1", "{not json")
    const fresh = createExtractedSourceMemory({ storage: () => storage as unknown as Storage, now: () => now })
    expect(fresh.has(video("v1.mp4"))).toBe(false)
    fresh.remember(video("again.mp4"))
    expect(fresh.has(video("again.mp4"))).toBe(true)
  })

  it("blocked storage still remembers for this tab", () => {
    const blocked = { getItem: () => { throw new Error("SecurityError") }, setItem: () => { throw new Error("QuotaExceededError") }, removeItem: () => {} }
    const memory = createExtractedSourceMemory({ storage: () => blocked as unknown as Storage })
    memory.remember(video("Clase.mp4"))
    expect(memory.has(video("Clase.mp4"))).toBe(true)
    expect(createExtractedSourceMemory({ storage: () => null }).has(video("Clase.mp4"))).toBe(false)
  })
})
