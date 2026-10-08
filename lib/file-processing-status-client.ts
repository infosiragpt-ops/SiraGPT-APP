/**
 * Pure helpers for GET /api/files/:id/processing-status polling.
 * Kept out of the React hook so URL construction and give-up rules
 * can be unit-tested without mounting the composer.
 */

import { getNormalizedApiBaseUrl } from "./api-base-url"
import {
  TERMINAL_STAGES,
  type FileProcessingStage,
} from "./file-processing-vocab"

export const STATUS_POLL_UNAVAILABLE = "No se pudo comprobar el estado del documento"

/** 404 retries before we treat the file as missing (covers brief replica lag). */
export const MISSING_STATUS_RETRY_LIMIT = 3

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
 */
export function resolveProcessingPollGiveUp(prevStage: FileProcessingStage | null | undefined): {
  stage: FileProcessingStage
  error: string | null
} {
  if (prevStage === "failed") {
    return { stage: "failed", error: null }
  }
  if (prevStage === "ready") {
    return { stage: "ready", error: null }
  }
  if (prevStage && !TERMINAL_STAGES.has(prevStage)) {
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
