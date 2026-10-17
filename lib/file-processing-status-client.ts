/**
 * Pure helpers for GET /api/files/:id/processing-status polling.
 * Kept out of the React hook so URL construction and give-up rules
 * can be unit-tested without mounting the composer.
 */

import { getNormalizedApiBaseUrl } from "./api-base-url"
import { isMediaUpload } from "./attachment-ingest"
import {
  TERMINAL_STAGES,
  type FileProcessingStage,
} from "./file-processing-vocab"

export const STATUS_POLL_UNAVAILABLE = "No se pudo comprobar el estado del documento"
export const STATUS_FILE_GONE = "El archivo ya no está disponible."

/** 404 retries before we treat the file as missing (covers brief replica lag). */
export const MISSING_STATUS_RETRY_LIMIT = 3

/** Poll cadence while a file is young. */
export const STATUS_POLL_INTERVAL_MS = 2_000
/** Long jobs (audio/video transcription) back off to this cadence… */
export const LONG_JOB_POLL_INTERVAL_MS = 15_000
/** …after keeping the fast cadence this long. */
export const LONG_JOB_FAST_WINDOW_MS = 2 * 60_000
/** Documents give up after 30 min (900 polls at 2 s) — OCR-heavy batches included. */
export const DOCUMENT_MAX_POLLS = 900
/**
 * Long media jobs have NO 30-min ceiling: a 5 h lecture transcribes for hours
 * (the job budget is 12 h). The loop only stops after a day, and even then
 * without inventing a verdict.
 */
export const LONG_JOB_MAX_POLL_MS = 24 * 60 * 60_000

export type ProcessingStatusPayloadLike = {
  mimeType?: string | null
  name?: string | null
  size?: number | null
  processingProgress?: unknown
} | null | undefined

/**
 * Audio/video (by MIME, or by file name when the MIME is missing/generic) or
 * any file whose status carries a `processingProgress` (the durable media
 * job's segments / % / ETA) is a long job: slower polling, no ceiling, never
 * "ready" until the server says so.
 */
export function isLongProcessingJob(payload: ProcessingStatusPayloadLike): boolean {
  if (!payload) return false
  if (payload.processingProgress) return true
  const mime = String(payload.mimeType || "").split(";")[0].trim().toLowerCase()
  if (/^(audio|video)\//.test(mime)) return true
  if (mime && mime !== "application/octet-stream") return false
  const name = String(payload.name || "")
  const size = Number(payload.size)
  return Boolean(name) && isMediaUpload({ type: "", name, size: Number.isFinite(size) ? size : undefined })
}

/** Delay before the next status read. */
export function processingPollDelayMs(input: { longJob: boolean; elapsedMs: number }): number {
  if (input.longJob && input.elapsedMs >= LONG_JOB_FAST_WINDOW_MS) return LONG_JOB_POLL_INTERVAL_MS
  return STATUS_POLL_INTERVAL_MS
}

/** Whether the poll loop has run long enough to stop. */
export function processingPollCeilingReached(input: { longJob: boolean; polls: number; elapsedMs: number }): boolean {
  if (input.longJob) return input.elapsedMs >= LONG_JOB_MAX_POLL_MS
  return input.polls >= DOCUMENT_MAX_POLLS
}

export function buildFileProcessingStatusUrl(
  fileId: string,
  apiRoot = getNormalizedApiBaseUrl(),
): string {
  const root = String(apiRoot || "").replace(/\/+$/, "")
  return `${root}/files/${encodeURIComponent(fileId)}/processing-status`
}

export type ProcessingPollAction = "apply" | "retry" | "stop"

export function decideProcessingStatusPoll(
  httpStatus: number,
  attempt: number,
): ProcessingPollAction {
  if (httpStatus === 200) return "apply"
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 410) return "stop"
  if (httpStatus === 404) return attempt <= MISSING_STATUS_RETRY_LIMIT ? "retry" : "stop"
  if (httpStatus === 429 || httpStatus >= 500) return "retry"
  return "retry"
}

/**
 * When polling hits its ceiling or a hard stop without a usable stage,
 * pick a terminal Spanish state so the chip never spins on the default
 * "preparando índice…" copy.
 *
 * A mid-pipeline stage that never finished is treated as ready: the
 * binary is already stored and chat can use extracted text. A poll that
 * never learned any stage is a status-check failure, not a successful index.
 *
 * Long media jobs are the exception: a transcription still running is NOT
 * "ready" (the chip used to claim «Listo para analizar» after 30 min while a
 * 5 h lecture was mid-way). Their last stage is kept, with `terminal: false`.
 */
export function resolveProcessingPollGiveUp(
  prevStage: FileProcessingStage | null | undefined,
  opts: { longJob?: boolean; httpStatus?: number } = {},
): {
  stage: FileProcessingStage
  error: string | null
  terminal?: false
} {
  if (prevStage === "failed") {
    return { stage: "failed", error: null }
  }
  if (prevStage === "ready") {
    return { stage: "ready", error: null }
  }
  if (opts.longJob && (opts.httpStatus === 404 || opts.httpStatus === 410)) {
    // The row is gone (deleted, purged): not a transcription still running.
    return { stage: "failed", error: STATUS_FILE_GONE }
  }
  if (prevStage && !TERMINAL_STAGES.has(prevStage)) {
    if (opts.longJob) return { stage: prevStage, error: null, terminal: false }
    return { stage: "ready", error: null }
  }
  return { stage: "failed", error: STATUS_POLL_UNAVAILABLE }
}

/**
 * Shared memo for the processing-status poll (2026-10-08).
 *
 * Every chip that shows a file (composer, message bubble, sync bridge) owns
 * its own `useFileProcessingStatus`, and a chat re-render remounts them, so
 * one attachment produced N identical GETs every 2 s and a fresh poll on each
 * remount even when the server had already said `ready`. One memo per tab:
 *
 *  - `shared(fileId, run)`: concurrent callers for the same file await ONE
 *    request;
 *  - `rememberTerminal` / `terminal`: a real terminal answer (`ready` /
 *    `failed`, from a 200) is reused for `ttlMs` without a request. Give-up
 *    states (401/403/410, poll ceiling) are never cached so a re-login or a
 *    recovered worker is seen again.
 */
export const TERMINAL_STATUS_CACHE_TTL_MS = 10 * 60_000
export const TERMINAL_STATUS_CACHE_MAX = 500

export class ProcessingStatusMemo<TStatus, TResult> {
  private readonly terminalByFile = new Map<string, { status: TStatus; at: number }>()
  private readonly inflight = new Map<string, Promise<TResult>>()

  constructor(
    private readonly options: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }

  /** The cached terminal status for `fileId`, or null when absent/expired. */
  terminal(fileId: string): TStatus | null {
    const hit = this.terminalByFile.get(fileId)
    if (!hit) return null
    const ttl = this.options.ttlMs ?? TERMINAL_STATUS_CACHE_TTL_MS
    if (this.now() - hit.at > ttl) {
      this.terminalByFile.delete(fileId)
      return null
    }
    return hit.status
  }

  rememberTerminal(fileId: string, status: TStatus): void {
    const max = this.options.max ?? TERMINAL_STATUS_CACHE_MAX
    if (!this.terminalByFile.has(fileId) && this.terminalByFile.size >= max) {
      const oldest = this.terminalByFile.keys().next().value
      if (oldest !== undefined) this.terminalByFile.delete(oldest)
    }
    this.terminalByFile.delete(fileId)
    this.terminalByFile.set(fileId, { status, at: this.now() })
  }

  /** Run `run` once per `fileId` at a time; concurrent callers share it. */
  shared(fileId: string, run: () => Promise<TResult>): Promise<TResult> {
    const pending = this.inflight.get(fileId)
    if (pending) return pending
    const flight = run().finally(() => {
      if (this.inflight.get(fileId) === flight) this.inflight.delete(fileId)
    })
    this.inflight.set(fileId, flight)
    return flight
  }

  inflightCount(): number {
    return this.inflight.size
  }

  reset(): void {
    this.terminalByFile.clear()
    this.inflight.clear()
  }
}
