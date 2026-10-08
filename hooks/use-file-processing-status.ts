"use client"

import * as React from "react"
import {
  type FileProcessingStage,
  TERMINAL_STAGES,
  describeStage as describeStageVocab,
  friendlyFailureLabel as friendlyFailureLabelVocab,
} from "@/lib/file-processing-vocab"
import { authenticatedFetch } from "@/lib/authenticated-fetch"
import {
  ProcessingStatusMemo,
  buildFileProcessingStatusUrl,
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

type StatusPayload = {
  fileId: string
  stage: FileProcessingStage
  error: string | null
  stageAt: string | null
  isTerminal: boolean
}

type PollOutcome =
  | { kind: "response"; status: number; data: StatusPayload | null }
  | { kind: "network_error" }

type Subscriber = (status: FileProcessingStatus) => void

type FilePoller = {
  fileId: string
  subscribers: Set<Subscriber>
  last: FileProcessingStatus
  polls: number
  timer: ReturnType<typeof setTimeout> | null
  onVisible: (() => void) | null
  stopped: boolean
}

const statusMemo = new ProcessingStatusMemo<FileProcessingStatus, PollOutcome>()
const pollers = new Map<string, FilePoller>()

function pendingStatus(fileId: string): FileProcessingStatus {
  return { fileId, stage: null, error: null, stageAt: null, isTerminal: false, loading: true, pending: true }
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  let token: string | null = null
  try {
    token = window.localStorage.getItem("auth-token")
  } catch {
    // Storage blocked (private mode, embedded webview): cookie auth still works.
    token = null
  }
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden"
}

function fetchStatusShared(fileId: string): Promise<PollOutcome> {
  return statusMemo.shared(fileId, async () => {
    try {
      const resp = await authenticatedFetch(
        buildFileProcessingStatusUrl(fileId),
        { headers: authHeader(), credentials: "include" },
      )
      if (resp.status !== 200) return { kind: "response", status: resp.status, data: null }
      let data: StatusPayload | null = null
      try {
        data = await resp.json() as StatusPayload
      } catch {
        data = null
      }
      return { kind: "response", status: 200, data }
    } catch {
      return { kind: "network_error" }
    }
  })
}

function stopPoller(poller: FilePoller): void {
  poller.stopped = true
  if (poller.timer) clearTimeout(poller.timer)
  poller.timer = null
  if (poller.onVisible && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", poller.onVisible)
  }
  poller.onVisible = null
  if (pollers.get(poller.fileId) === poller) pollers.delete(poller.fileId)
}

function publish(poller: FilePoller, status: FileProcessingStatus): void {
  poller.last = status
  for (const subscriber of poller.subscribers) {
    try {
      subscriber(status)
    } catch {
      /* a consumer's setState after unmount is harmless; never break the loop */
    }
  }
}

function giveUp(poller: FilePoller, timedOut: boolean): void {
  const next = resolveProcessingPollGiveUp(poller.last.stage)
  publish(poller, {
    ...poller.last,
    loading: false,
    pending: false,
    isTerminal: true,
    stage: next.stage,
    error: poller.last.error || next.error,
    ...(timedOut ? { timedOut: true } : {}),
  })
  stopPoller(poller)
}

function schedule(poller: FilePoller): void {
  if (poller.stopped) return
  if (isDocumentHidden()) {
    // Nobody is looking: wait for the tab to come back instead of polling
    // every 2 s in the background (Chrome throttles the timer anyway, but
    // every wake-up still cost a request).
    poller.onVisible = () => {
      if (isDocumentHidden()) return
      if (poller.onVisible) document.removeEventListener("visibilitychange", poller.onVisible)
      poller.onVisible = null
      if (!poller.stopped) void tick(poller)
    }
    document.addEventListener("visibilitychange", poller.onVisible)
    return
  }
  poller.timer = setTimeout(() => { poller.timer = null; void tick(poller) }, POLL_INTERVAL_MS)
}

async function tick(poller: FilePoller): Promise<void> {
  poller.polls += 1
  const outcome = await fetchStatusShared(poller.fileId)
  if (poller.stopped) return
  if (outcome.kind === "response") {
    const decision = decideProcessingStatusPoll(outcome.status, poller.polls)
    if (decision === "stop") {
      giveUp(poller, false)
      return
    }
    if (decision === "apply" && outcome.data) {
      const data = outcome.data
      const isTerminal = data.isTerminal || TERMINAL.has(data.stage)
      const next: FileProcessingStatus = {
        fileId: data.fileId,
        stage: data.stage,
        error: data.error,
        stageAt: data.stageAt,
        isTerminal,
        loading: !isTerminal,
        pending: false,
      }
      publish(poller, next)
      if (isTerminal) {
        // Only a real server verdict is remembered; give-up states are not,
        // so a re-login or a recovered worker is seen again.
        statusMemo.rememberTerminal(poller.fileId, next)
        stopPoller(poller)
        return
      }
    }
    // "retry" (5xx / 429 / early 404 / other non-OK) or a 200 without a
    // readable body — keep polling.
  }
  // Transient network error — keep polling on the same cadence until the
  // ceiling so a flaky connection doesn't permanently freeze the badge.
  if (poller.polls >= MAX_POLLS) {
    // Never leave the chip frozen on "Indexando" forever. The file is
    // already uploaded and its text extracted — RAG indexing is a
    // best-effort background enhancement, not a prerequisite for using
    // the document. Resolve to a usable terminal state so the UI stops
    // showing an in-progress spinner once the worker is clearly wedged.
    giveUp(poller, true)
    return
  }
  schedule(poller)
}

/** Attach to the (single) poll loop for `fileId`; returns the detach function. */
function subscribeToFileStatus(fileId: string, subscriber: Subscriber): () => void {
  let poller = pollers.get(fileId)
  if (!poller) {
    poller = {
      fileId,
      subscribers: new Set(),
      last: pendingStatus(fileId),
      polls: 0,
      timer: null,
      onVisible: null,
      stopped: false,
    }
    pollers.set(fileId, poller)
    // Kick off the first read immediately; subsequent reads are paced.
    void tick(poller)
  }
  poller.subscribers.add(subscriber)
  if (!poller.last.pending) subscriber(poller.last)
  return () => {
    poller.subscribers.delete(subscriber)
    if (poller.subscribers.size === 0) stopPoller(poller)
  }
}

/** Test seam: forget cached terminal answers and stop every poll loop. */
export function resetFileProcessingStatusMemo(): void {
  for (const poller of [...pollers.values()]) stopPoller(poller)
  pollers.clear()
  statusMemo.reset()
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
      return
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
