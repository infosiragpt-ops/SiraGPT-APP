/**
 * Prepares the composer's files for upload: every recording worth it has
 * its audio extracted in the browser first (lib/media/client-audio-extract),
 * a few at a time, keeping the file ↔ chip alignment, a per-file abort (the
 * chip's ✕) and a per-file progress. Pure orchestration: the extractor and
 * the plan are injectable, nothing here touches the DOM or the network.
 *
 * Whatever happens to an extraction, the upload goes on: a file that could
 * not be extracted (or whose extraction was cancelled) is uploaded as it is.
 */

import { createSlotLimiter, runUploadQueue, type SlotLimiter } from "../composer/upload-scheduler"
import { extractedSourceMemory, type ExtractedSourceMemory } from "./extracted-source-memory"
import {
  clientExtractedMetadata,
  extractAudioForTranscription,
  planAudioExtraction,
  type ClientExtractedMetadata,
  type ExtractionOutcome,
  type ExtractionProgress,
} from "./client-audio-extract"

/** Share of a chip's progress (0–100) that the browser-side extraction occupies; the upload fills the rest. */
export const EXTRACTION_PROGRESS_SHARE = 40
/** No progress event for this long: the extraction is stuck, the original goes instead. */
export const EXTRACTION_STALL_MS = 60_000
/** An aborted extraction that does not stop within this gives its slot back anyway. */
export const EXTRACTION_ABORT_GRACE_MS = 5_000

export type ExtractFn = (file: File, opts: { signal?: AbortSignal; onProgress?: (p: ExtractionProgress) => void }) => Promise<ExtractionOutcome>

export type PrepareMediaOptions = {
  extract?: ExtractFn
  plan?: (file: File) => { eligible: boolean; reason: string }
  /** Videos whose audio alone already uploaded: attaching one again uploads it whole (default: the browser's). */
  memory?: ExtractedSourceMemory
  /** Extractions running in the whole tab (default: one limiter shared by every batch, drop and retry). */
  limiter?: ExtractionLimiter
  /** An extraction with no progress for this long is abandoned and the original uploaded (default EXTRACTION_STALL_MS). */
  stallMs?: number
  /** How long an aborted extraction may take to stop before its slot is given back anyway (default EXTRACTION_ABORT_GRACE_MS). */
  graceMs?: number
  /** Extractions at once (CPU-bound; default from the machine's cores). */
  concurrency?: number
  /** Cancels every pending and running extraction (the originals are uploaded). */
  signal?: AbortSignal
  /** A per-file signal (the chip's cancel); aborting it skips that file's extraction. */
  signalFor?: (index: number) => AbortSignal | undefined
  /** 0–1 of the extraction of file `index`. */
  onProgress?: (index: number, fraction: number) => void
  onOutcome?: (index: number, outcome: ExtractionOutcome | { tier: "none"; reason: "cancelled" | "failed" }) => void
}

export type PreparedMedia = {
  /** Same length and order as the input; extracted recordings replaced by their audio file. */
  files: File[]
  /** Metadata for the upload, keyed by the NEW File object. */
  clientExtracted: Map<File, ClientExtractedMetadata>
  extracted: number
  skipped: number
  cancelled: number
  failed: number
}

/** Extractions at once: WebCodecs already uses several threads; one or two files keep the UI responsive. */
export function defaultExtractionConcurrency(hardwareConcurrency: number | undefined = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined): number {
  const cores = Number(hardwareConcurrency) || 4
  return cores >= 8 ? 2 : 1
}

function abortError(): Error {
  try {
    return new DOMException("The extraction was aborted.", "AbortError")
  } catch {
    return Object.assign(new Error("The extraction was aborted."), { name: "AbortError" })
  }
}

/** A FIFO counting semaphore (upload-scheduler's): a waiter whose signal aborts leaves the line. */
export type ExtractionLimiter = SlotLimiter
export const createExtractionLimiter = createSlotLimiter

let sharedLimiter: ExtractionLimiter | null = null

/**
 * The tab's extraction limiter, sized by the machine: every composer batch,
 * every drop and every retry takes a slot, so decodes never multiply with
 * the upload width (NEXT_PUBLIC_COMPOSER_PARALLEL_UPLOADS is network only).
 */
export function sharedExtractionLimiter(): ExtractionLimiter {
  if (!sharedLimiter) sharedLimiter = createExtractionLimiter(defaultExtractionConcurrency())
  return sharedLimiter
}

/**
 * One extraction under a watchdog. No progress for `stallMs`: it is aborted
 * and resolves as `stalled` (the original is uploaded). Aborted by the
 * caller: it rejects once the extraction stops, or after `graceMs` if it
 * ignores the abort, so a stuck decode never keeps its limiter slot.
 */
function guardedExtract(
  extract: ExtractFn,
  file: File,
  opts: { signal?: AbortSignal; onProgress: (p: ExtractionProgress) => void; stallMs: number; graceMs: number },
): Promise<ExtractionOutcome> {
  const stall = new AbortController()
  const signal = anySignal([opts.signal, stall.signal])
  const stalled = (): ExtractionOutcome => ({ sourceName: file.name, sourceSize: file.size, sourceType: file.type || "", tier: "none", reason: "stalled" })
  return new Promise<ExtractionOutcome>((resolve, reject) => {
    let done = false
    let lastProgressAt = Date.now()
    let grace: ReturnType<typeof setTimeout> | null = null
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearInterval(watchdog)
      if (grace) clearTimeout(grace)
      opts.signal?.removeEventListener("abort", startGrace)
      settle()
    }
    const userAborted = () => Boolean(opts.signal?.aborted)
    const giveUp = () => finish(() => (userAborted() ? reject(abortError()) : resolve(stalled())))
    function startGrace() { if (!grace) grace = setTimeout(giveUp, opts.graceMs) }
    opts.signal?.addEventListener("abort", startGrace, { once: true })
    const watchdog = setInterval(() => {
      if (stall.signal.aborted || Date.now() - lastProgressAt < opts.stallMs) return
      stall.abort()
      startGrace()
    }, Math.max(10, Math.min(5_000, Math.floor(opts.stallMs / 4))))
    let work: Promise<ExtractionOutcome>
    try {
      work = extract(file, { signal, onProgress: (p) => { lastProgressAt = Date.now(); opts.onProgress(p) } })
    } catch (err) {
      work = Promise.reject(err)
    }
    work.then(
      (outcome) => finish(() => resolve(outcome)),
      (err) => finish(() => (stall.signal.aborted && !userAborted() ? resolve(stalled()) : reject(err))),
    )
  })
}

/** 0–1 of an extraction from its progress events. */
export function extractionFraction(progress: ExtractionProgress): number {
  if (progress.phase === "probing") return 0
  if (progress.phase === "converting") return Math.max(0, Math.min(0.97, Number(progress.progress) || 0)) * 0.97
  return progress.progress >= 1 ? 1 : 0.97
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => Boolean(s))
  if (live.length === 0) return undefined
  if (live.length === 1) return live[0]
  const controller = new AbortController()
  for (const signal of live) {
    if (signal.aborted) { controller.abort(signal.reason); break }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

export async function prepareMediaForUpload(files: File[], options: PrepareMediaOptions = {}): Promise<PreparedMedia> {
  const extract = options.extract ?? ((file, opts) => extractAudioForTranscription(file, opts))
  const memory = options.memory ?? extractedSourceMemory()
  const limiter = options.limiter ?? sharedExtractionLimiter()
  // A video attached again after its audio alone was uploaded: the user
  // wants the video itself this time (frames, subtitles, on-screen text).
  const plan = options.plan ?? ((file: File) => {
    const planned = planAudioExtraction(file)
    return planned.eligible && planned.kind === "video" && memory.has(file)
      ? { ...planned, eligible: false, reason: "reattached_original" }
      : planned
  })
  const out: PreparedMedia = { files: files.slice(), clientExtracted: new Map(), extracted: 0, skipped: 0, cancelled: 0, failed: 0 }
  const eligible: number[] = []
  files.forEach((file, index) => {
    if (file instanceof Blob && plan(file).eligible) eligible.push(index)
  })
  if (eligible.length === 0) return out

  const jobs = eligible.map((index) => ({
    id: String(index),
    run: async (jobSignal: AbortSignal) => {
      const signal = anySignal([jobSignal, options.signalFor?.(index)])
      // The slot is held until the extraction really stops, even after the
      // queue settled a cancelled job: no more decodes than the limiter allows.
      const release = await limiter.acquire(signal)
      try {
        return await guardedExtract(extract, files[index], {
          signal,
          stallMs: options.stallMs ?? EXTRACTION_STALL_MS,
          graceMs: options.graceMs ?? EXTRACTION_ABORT_GRACE_MS,
          onProgress: (p) => { try { options.onProgress?.(index, extractionFraction(p)) } catch { /* observers never break the upload */ } },
        })
      } finally {
        release()
      }
    },
  }))
  const outcomes = await runUploadQueue(jobs, {
    concurrency: options.concurrency ?? defaultExtractionConcurrency(),
    signal: options.signal,
  }).done

  outcomes.forEach((outcome) => {
    const index = Number(outcome.id)
    if (outcome.status === "fulfilled") {
      const result = outcome.value
      if (result.tier === "none") out.skipped += 1
      else {
        out.files[index] = result.file
        out.clientExtracted.set(result.file, clientExtractedMetadata(result))
        out.extracted += 1
      }
      try { options.onOutcome?.(index, result) } catch { /* observers never break the upload */ }
    } else if (outcome.status === "cancelled") {
      out.cancelled += 1
      try { options.onOutcome?.(index, { tier: "none", reason: "cancelled" }) } catch { /* observers never break the upload */ }
    } else {
      out.failed += 1
      try { options.onOutcome?.(index, { tier: "none", reason: "failed" }) } catch { /* observers never break the upload */ }
    }
  })
  return out
}
