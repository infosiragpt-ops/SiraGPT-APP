"use client"

import * as React from "react"
import {
  type FileProcessingStage,
  TERMINAL_STAGES,
  describeStage as describeStageVocab,
  friendlyFailureLabel as friendlyFailureLabelVocab,
} from "@/lib/file-processing-vocab"
import { getSameOriginApiBaseUrl } from "@/lib/api-base-url"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import {
  ProcessingStatusMemo,

  decideProcessingStatusPoll,
  resolveProcessingPollGiveUp,
} from "@/lib/file-processing-status-client"

// Re-export the vocab so existing import sites
// (`from "@/hooks/use-file-processing-status"`) keep working.
export type { FileProcessingStage } from "@/lib/file-processing-vocab"
export const describeStage = describeStageVocab
export const friendlyFailureLabel = friendlyFailureLabelVocab

/**
 * Polls GET /api/files/:id/processing-status until the file's
 * processing pipeline reaches a terminal stage (`ready` or `failed`)
 * or the consumer unmounts.
 *
 * Why polling instead of SSE/WebSocket:
 *   - The status sequence is short (uploaded → ... → ready) and tends
 *     to finish in seconds, so a 2 s poll is cheap.
 *   - The endpoint is read-only and cacheable; an SSE stream per
 *     attachment would add server-side state we don't need.
 *
 * Cost controls (2026-10-08): ONE poll loop per file id shared by every
 * chip that shows it (composer, bubble, sync bridge — a chat re-render
 * remounts them all); a terminal answer is reused for 10 min across
 * remounts; and the loop pauses while the tab is hidden, resuming on the
 * next `visibilitychange`.
 *
 * The hook is intentionally tolerant — a missing fileId, a 404
 * (legacy row), an auth failure, or a network blip all leave the
 * hook idle without throwing into the React tree.
 */

const TERMINAL = TERMINAL_STAGES

export interface FileProcessingStatus {
  fileId: string | null
  stage: FileProcessingStage | null
  error: string | null
  stageAt: string | null
  isTerminal: boolean
  loading: boolean
  /** True while we have a fileId but haven't seen the first response yet. */
  pending: boolean
  /** True when polling hit its ceiling before a terminal stage — the file
   *  is treated as usable so the UI never freezes on "Indexando". */
  timedOut?: boolean
  processingProgress?: { stage?: string; percent?: number; etaSeconds?: number; [key: string]: unknown } | null
}

const INITIAL: FileProcessingStatus = {
  fileId: null,
  stage: null,
  error: null,
  stageAt: null,
  isTerminal: false,
  loading: false,
  pending: false,
}

const POLL_INTERVAL_MS = 2_000
const MAX_POLLS = 900 // 30 minutes ceiling — OCR-heavy batches can legitimately take longer.

type Subscriber = (status: FileProcessingStatus) => void
type FilePoller = { fileId: string; subscribers: Set<Subscriber>; last: FileProcessingStatus; polls: number; missing: number }
const statusMemo = new ProcessingStatusMemo<FileProcessingStatus, never>()
const pollers = new Map<string, FilePoller>()
let timer: ReturnType<typeof setTimeout> | null = null
let inFlight: AbortController | null = null
let listening = false

function pendingStatus(fileId: string): FileProcessingStatus {
  return { fileId, stage: null, error: null, stageAt: null, isTerminal: false, loading: true, pending: true }
}
function canPoll(): boolean {
  return (typeof document === "undefined" || document.visibilityState !== "hidden")
    && (typeof navigator === "undefined" || navigator.onLine !== false)
}
function activePollers() { return [...pollers.values()].filter(p => !p.last.isTerminal && p.subscribers.size > 0) }
function publish(poller: FilePoller, status: FileProcessingStatus): void {
  poller.last = status
  for (const subscriber of poller.subscribers) subscriber(status)
}
function giveUp(poller: FilePoller, timedOut: boolean): void {
  const next = resolveProcessingPollGiveUp(poller.last.stage)
  publish(poller, { ...poller.last, ...next, error: poller.last.error || next.error, loading: false, pending: false, isTerminal: true, ...(timedOut ? { timedOut: true } : {}) })
}
function schedule(delay = POLL_INTERVAL_MS): void {
  if (timer || inFlight || !canPoll() || activePollers().length === 0) return
  timer = setTimeout(() => { timer = null; void tick() }, delay)
}
function onWake(): void {
  if (!canPoll()) {
    if (timer) clearTimeout(timer)
    timer = null
    inFlight?.abort()
    return
  }
  schedule(0)
}
function listen(): void {
  if (listening || typeof window === "undefined") return
  listening = true
  document.addEventListener("visibilitychange", onWake)
  window.addEventListener("online", onWake)
  window.addEventListener("offline", onWake)
}
function stopIfUnused(): void {
  if (pollers.size) return
  if (timer) clearTimeout(timer)
  timer = null
  inFlight?.abort()
  if (listening) {
    document.removeEventListener("visibilitychange", onWake)
    window.removeEventListener("online", onWake)
    window.removeEventListener("offline", onWake)
  }
  listening = false
}
async function tick(): Promise<void> {
  if (inFlight || !canPoll()) return
  const controller = new AbortController()
  inFlight = controller
  const entries = activePollers()
  try {
    for (let start = 0; start < entries.length && !controller.signal.aborted && canPoll(); start += 50) {
      const batch = entries.slice(start, start + 50).filter(p => pollers.get(p.fileId) === p)
      if (!batch.length) continue
      const root = getSameOriginApiBaseUrl().replace(/\/+$/, "")
      const response = await authenticatedFetch(`${root}/files/processing-status?ids=${encodeURIComponent(batch.map(p => p.fileId).join(','))}`, {
        credentials: "include", signal: controller.signal,
      })
      if (controller.signal.aborted) return
      const body = response.status === 200 ? await response.json().catch(() => null) : null
      const rows: any[] = Array.isArray(body?.files) ? body.files : Array.isArray(body?.statuses) ? body.statuses : body?.fileId ? [body] : []
      const byId = new Map(rows.map(row => [String(row.id || row.fileId), row]))
      for (const poller of batch) {
        if (pollers.get(poller.fileId) !== poller) continue
        poller.polls += 1
        const row = byId.get(poller.fileId)
        const stage = row?.processingStage || row?.stage
        if (response.status === 200 && stage) {
          poller.missing = 0
          const terminal = Boolean(row.isTerminal || TERMINAL.has(stage))
          const next: FileProcessingStatus = {
            fileId: poller.fileId, stage, error: row.processingError ?? row.error ?? null,
            stageAt: row.processingStageAt ?? row.stageAt ?? null, isTerminal: terminal, loading: !terminal, pending: false,
            processingProgress: terminal ? null : row.processingProgress ?? null,
          }
          publish(poller, next)
          if (terminal) statusMemo.rememberTerminal(poller.fileId, next)
        } else {
          if (response.status === 200) poller.missing += 1
          const status = response.status === 200 && !row ? 404 : response.status
          if (decideProcessingStatusPoll(status, status === 404 ? poller.missing : poller.polls) === "stop") giveUp(poller, false)
          else if (poller.polls >= MAX_POLLS) giveUp(poller, true)
        }
      }
    }
  } catch {
    // Network errors never convert stored files into failures; visible/online resumes.
  } finally {
    if (inFlight === controller) inFlight = null
    schedule()
  }
}
function subscribeToFileStatus(fileId: string, subscriber: Subscriber): () => void {
  let poller = pollers.get(fileId)
  if (!poller) {
    poller = { fileId, subscribers: new Set(), last: statusMemo.terminal(fileId) || pendingStatus(fileId), polls: 0, missing: 0 }
    pollers.set(fileId, poller)
  }
  poller.subscribers.add(subscriber)
  subscriber(poller.last)
  listen()
  schedule(0)
  return () => {
    poller.subscribers.delete(subscriber)
    if (poller.subscribers.size === 0 && pollers.get(fileId) === poller) pollers.delete(fileId)
    stopIfUnused()
  }
}
/** Retrying a processing job invalidates its old ready/failed verdict. */
export function invalidateFileProcessingStatus(fileId: string): void {
  statusMemo.forget(fileId)
  const poller = pollers.get(fileId)
  if (poller) { poller.polls = 0; poller.missing = 0; publish(poller, pendingStatus(fileId)); schedule(0) }
}
export function resetFileProcessingStatusMemo(): void {
  pollers.clear()
  stopIfUnused()
  statusMemo.reset()
}

/** Collection subscribers and chips share the very same batched transport. */
export function subscribeToFileProcessingStatuses(fileIds: string[], subscriber: Subscriber): () => void {
  const unsubscribe = [...new Set(fileIds)].map(id => subscribeToFileStatus(id, subscriber))
  return () => unsubscribe.forEach(stop => stop())
}

export function useFileProcessingStatus(
  fileId: string | null | undefined,
): FileProcessingStatus {
  const [state, setState] = React.useState<FileProcessingStatus>(INITIAL)

  React.useEffect(() => {
    if (!fileId) {
      setState(INITIAL)
      return
    }
    const cached = statusMemo.terminal(fileId)
    if (cached) {
      // The server already said ready/failed for this file: no request.
      setState(cached)
      return subscribeToFileStatus(fileId, setState)
    }
    setState(pendingStatus(fileId))
    return subscribeToFileStatus(fileId, setState)
  }, [fileId])

  return state
}

// describeStage / friendlyFailureLabel now live in
// `lib/file-processing-vocab.ts` so they can be unit-tested without
// pulling React into the test harness. Re-exported at the top of
// this file for backwards compat with existing import sites.
