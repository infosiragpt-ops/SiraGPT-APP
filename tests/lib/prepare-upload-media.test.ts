import { describe, expect, it } from "vitest"

import { defaultExtractionConcurrency, extractionFraction, prepareMediaForUpload } from "@/lib/media/prepare-upload-media"
import type { ExtractionOutcome } from "@/lib/media/client-audio-extract"

/**
 * The composer's upload preparation: eligible recordings are extracted a
 * few at a time, each replaced by its audio file with the metadata for the
 * upload; files whose extraction yields nothing, fails or is cancelled are
 * uploaded as they are; order and alignment with the chips never change.
 */

const MB = 1024 * 1024
const file = (name: string, type: string, size: number) => Object.defineProperty(new File([new Uint8Array(8)], name, { type }), "size", { value: size })
const tick = () => new Promise((r) => setTimeout(r, 0))

const extractedOutcome = (source: File, name: string): ExtractionOutcome => ({
  tier: "opus",
  file: new File([new Uint8Array(4)], name, { type: "audio/ogg" }),
  sourceName: source.name,
  sourceSize: source.size,
  sourceType: source.type,
  codec: "aac",
  durationSeconds: 3600,
  bytesSaved: source.size - 4,
  ms: 10,
})

describe("prepareMediaForUpload", () => {
  it("extracts eligible recordings with bounded concurrency, replaces them in place and keeps the rest untouched", async () => {
    const files = [file("a.mp4", "video/mp4", 500 * MB), file("notas.pdf", "application/pdf", 1 * MB), file("b.mkv", "video/x-matroska", 900 * MB), file("c.mp3", "audio/mpeg", 100 * MB)]
    const started: string[] = []
    let active = 0
    let peak = 0
    const gates = new Map<string, () => void>()
    const extract = (f: File, opts: { onProgress?: (p: any) => void }) => new Promise<ExtractionOutcome>((resolve) => {
      started.push(f.name)
      peak = Math.max(peak, ++active)
      opts.onProgress?.({ phase: "probing", progress: 0 })
      opts.onProgress?.({ phase: "converting", progress: 0.5 })
      gates.set(f.name, () => { active -= 1; opts.onProgress?.({ phase: "verifying", progress: 1 }); resolve(f.name === "c.mp3" ? { tier: "none", reason: "no_gain", sourceName: f.name, sourceSize: f.size, sourceType: f.type } : extractedOutcome(f, f.name.replace(/\.\w+$/, ".audio.ogg"))) })
    })
    const progress: Array<[number, number]> = []
    const outcomes: Array<[number, string]> = []
    const pending = prepareMediaForUpload(files, { extract, concurrency: 2, onProgress: (i, p) => progress.push([i, p]), onOutcome: (i, o) => outcomes.push([i, o.tier]) })
    await tick()
    expect(started).toEqual(["a.mp4", "b.mkv"], "two at a time, in order; the PDF is never considered")
    gates.get("a.mp4")!()
    await tick()
    expect(started).toEqual(["a.mp4", "b.mkv", "c.mp3"])
    gates.get("b.mkv")!()
    gates.get("c.mp3")!()
    const prepared = await pending
    expect(peak).toBe(2)
    expect(prepared.files.map((f) => f.name)).toEqual(["a.audio.ogg", "notas.pdf", "b.audio.ogg", "c.mp3"])
    expect(prepared.files[1]).toBe(files[1])
    expect(prepared.files[3]).toBe(files[3])
    expect(prepared.extracted).toBe(2)
    expect(prepared.skipped).toBe(1)
    expect(prepared.clientExtracted.get(prepared.files[0])).toEqual({ tier: "opus", sourceName: "a.mp4", sourceSize: 500 * MB, sourceType: "video/mp4", codec: "aac", durationSeconds: 3600 })
    expect(prepared.clientExtracted.has(prepared.files[3])).toBe(false)
    expect(progress.filter(([i]) => i === 0).map(([, p]) => p)).toEqual([0, 0.5 * 0.97, 1])
    expect(outcomes.sort()).toEqual([[0, "opus"], [2, "opus"], [3, "none"]])
  })

  it("a failed or cancelled extraction uploads the original; the per-file signal and the global signal both cancel", async () => {
    const files = [file("a.mp4", "video/mp4", 500 * MB), file("b.mp4", "video/mp4", 500 * MB), file("c.mp4", "video/mp4", 500 * MB)]
    const chip = new AbortController()
    const extract = (f: File, opts: { signal?: AbortSignal }) => new Promise<ExtractionOutcome>((resolve, reject) => {
      if (f.name === "a.mp4") { reject(new Error("decoder crashed")); return }
      opts.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")), { once: true })
      if (f.name === "c.mp4") setTimeout(() => resolve(extractedOutcome(f, "c.audio.ogg")), 5)
    })
    const outcomes: string[] = []
    const pending = prepareMediaForUpload(files, { extract, concurrency: 3, signalFor: (i) => (i === 1 ? chip.signal : undefined), onOutcome: (i, o) => outcomes.push(`${i}:${o.tier}:${"reason" in o ? o.reason : ""}`) })
    await tick()
    chip.abort()
    const prepared = await pending
    expect(prepared.files.map((f) => f.name)).toEqual(["a.mp4", "b.mp4", "c.audio.ogg"])
    expect(prepared.failed).toBe(1)
    expect(prepared.cancelled).toBe(1)
    expect(prepared.extracted).toBe(1)
    expect(outcomes.sort()).toEqual(["0:none:failed", "1:none:cancelled", "2:opus:"])

    const all = new AbortController()
    const never = () => new Promise<ExtractionOutcome>(() => {})
    const p2 = prepareMediaForUpload([file("x.mp4", "video/mp4", 500 * MB)], { extract: never, signal: all.signal })
    await tick()
    all.abort()
    const r2 = await p2
    expect(r2.cancelled).toBe(1)
    expect(r2.files[0].name).toBe("x.mp4")
  })

  it("nothing eligible → the input is returned as is, without calling the extractor; helpers", async () => {
    let calls = 0
    const prepared = await prepareMediaForUpload([file("doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 5 * MB), file("nota.ogg", "audio/ogg", 1 * MB)], { extract: async () => { calls += 1; throw new Error("no") } })
    expect(calls).toBe(0)
    expect(prepared.files).toHaveLength(2)
    expect(prepared.clientExtracted.size).toBe(0)
    expect(defaultExtractionConcurrency(4)).toBe(1)
    expect(defaultExtractionConcurrency(12)).toBe(2)
    expect(defaultExtractionConcurrency(undefined)).toBe(1)
    expect(extractionFraction({ phase: "probing", progress: 1 })).toBe(0)
    expect(extractionFraction({ phase: "converting", progress: 2 })).toBeCloseTo(0.97 * 0.97)
    expect(extractionFraction({ phase: "verifying", progress: 0 })).toBe(0.97)
    expect(extractionFraction({ phase: "verifying", progress: 1 })).toBe(1)
  })
})
