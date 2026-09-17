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
