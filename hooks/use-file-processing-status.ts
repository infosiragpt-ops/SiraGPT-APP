"use client"

import * as React from "react"
import {
  type FileProcessingStage,
  TERMINAL_STAGES,
  describeStage as describeStageVocab,
  friendlyFailureLabel as friendlyFailureLabelVocab,
} from "@/lib/file-processing-vocab"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

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

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"
const POLL_INTERVAL_MS = 2_000
const MAX_POLLS = 900 // 30 minutes ceiling — OCR-heavy batches can legitimately take longer.

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage?.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
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
    let cancelled = false
    let polls = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    setState({
      fileId,
      stage: null,
      error: null,
      stageAt: null,
      isTerminal: false,
      loading: true,
      pending: true,
    })

    const tick = async () => {
      polls += 1
      try {
        const resp = await authenticatedFetch(
          `${API_ROOT}/files/${encodeURIComponent(fileId)}/processing-status`,
          { headers: authHeader(), credentials: "include" },
        )
        if (cancelled) return
        if (!resp.ok) {
          // 404 means legacy row (no state machine columns yet) or
          // file removed; either way, stop polling and surface the
          // last-known state. 401/403 means we shouldn't retry.
          setState((prev) => ({
            ...prev,
            loading: false,
            pending: false,
            isTerminal: true,
            stage: prev.stage,
          }))
          return
        }
        const data = await resp.json() as {
          fileId: string
          stage: FileProcessingStage
          error: string | null
          stageAt: string | null
          isTerminal: boolean
        }
        if (cancelled) return
        const isTerminal = data.isTerminal || TERMINAL.has(data.stage)
        setState({
          fileId: data.fileId,
          stage: data.stage,
          error: data.error,
          stageAt: data.stageAt,
          isTerminal,
          loading: !isTerminal,
          pending: false,
        })
        if (isTerminal) return
      } catch {
        // Transient network error — keep polling on the same cadence
        // until the ceiling so a flaky connection doesn't permanently
        // freeze the badge.
        if (cancelled) return
      }
      if (polls >= MAX_POLLS) {
        // Never leave the chip frozen on "Indexando" forever. The file is
        // already uploaded and its text extracted — RAG indexing is a
        // best-effort background enhancement, not a prerequisite for using
        // the document. Resolve to a usable terminal state so the UI stops
        // showing an in-progress spinner once the worker is clearly wedged.
        setState((prev) => ({
          ...prev,
          loading: false,
          pending: false,
          isTerminal: true,
          stage: prev.stage && !TERMINAL.has(prev.stage) ? "ready" : prev.stage,
          timedOut: true,
        }))
        return
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    // Kick off the first read immediately; subsequent reads are paced.
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [fileId])

  return state
}

// describeStage / friendlyFailureLabel now live in
// `lib/file-processing-vocab.ts` so they can be unit-tested without
// pulling React into the test harness. Re-exported at the top of
// this file for backwards compat with existing import sites.
