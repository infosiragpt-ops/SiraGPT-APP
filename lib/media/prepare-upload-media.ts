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

import { runUploadQueue } from "../composer/upload-scheduler"
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

export type ExtractFn = (file: File, opts: { signal?: AbortSignal; onProgress?: (p: ExtractionProgress) => void }) => Promise<ExtractionOutcome>

export type PrepareMediaOptions = {
  extract?: ExtractFn
  plan?: (file: File) => { eligible: boolean; reason: string }
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
  const plan = options.plan ?? ((file: File) => planAudioExtraction(file))
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
      return extract(files[index], {
        signal,
        onProgress: (p) => { try { options.onProgress?.(index, extractionFraction(p)) } catch { /* observers never break the upload */ } },
      })
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
