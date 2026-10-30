"use client"

import { useEffect, useMemo, useState } from "react"
import { apiClient } from "@/lib/api"
import { startSerializedPreviewPoll, type SerializedPreviewPollController } from "@/lib/code-preview-poll"
import { describeMediaTranscriptionProgress } from "@/lib/chat/composer-files"
import { pendingMediaDeliveries, type MediaDeliveryMessage, type PendingMediaDelivery } from "@/lib/media-delivery-refresh"

export type MediaDeliveryProgress = {
  pending: true
  label: string
  percent: number | null
  stage: string | null
}

type ProcessingRow = {
  id?: unknown
  processingStage?: unknown
  processingProgress?: { stage?: unknown; percent?: unknown; etaSeconds?: unknown } | null
}

type Snapshot = { key: string; rows: Record<string, ProcessingRow>; unavailable: boolean }

function progressFor(delivery: PendingMediaDelivery, snapshot?: Snapshot): MediaDeliveryProgress {
  const state = (label: string, stage: string | null = null, percent: number | null = null): MediaDeliveryProgress => ({ pending: true, label, stage, percent })
  if (snapshot?.unavailable) return state("No se pudo actualizar el estado del trabajo.", "unavailable")
  const rows = delivery.sourceFileIds.map(id => snapshot?.rows[id])
  if (!snapshot) return state("Recuperando estado del trabajo…", "recovering")
  const knownStages = ["uploaded", "validating", "extracting", "normalizing", "chunking", "embedding", "indexing", "ready", "failed"]
  if (!rows.length || rows.some(row => !row || !knownStages.includes(String(row.processingStage)))) {
    return state("Estado del trabajo no disponible.", "unavailable")
  }
  const allTerminal = rows.every(row => row?.processingStage === "ready" || row?.processingStage === "failed")
  if (allTerminal) return rows.some(row => row?.processingStage === "failed")
    ? state("No se pudo completar la transcripción. Recuperando el resultado…", "failed")
    : state("Esperando el resultado…", "delivering")
  // Separate recordings may have very different lengths. Averaging their
  // percentages would invent an overall estimate the server never supplied.
  if (rows.length > 1) return state(`Transcribiendo ${rows.length} archivos…`, "transcribing")
  const row = rows[0]!
  const progress = row.processingProgress
  const percent = typeof progress?.percent === "number" && Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(99, Math.round(progress.percent))) : null
  if (progress?.stage === "preparing" || ["uploaded", "validating"].includes(String(row.processingStage))) {
    return state("Preparando audio…", "preparing")
  }
  if (percent !== null) {
    return state(describeMediaTranscriptionProgress({ ...progress, percent }) || "Transcribiendo…", "transcribing", percent)
  }
  return state("Transcribiendo…", "transcribing")
}

/** Restore the existing durable work's live status; never enqueue or retry it. */
export function useMediaDeliveryProgress({ chatId, ownerId, enabled = true, messages }: {
  chatId: string | null | undefined
  ownerId: string | null | undefined
  enabled?: boolean
  messages: readonly MediaDeliveryMessage[]
}): Record<string, MediaDeliveryProgress> {
  const pending = useMemo(() => pendingMediaDeliveries(messages), [messages])
  const pendingKey = JSON.stringify(pending)
  const key = JSON.stringify([chatId || "", ownerId || "", pendingKey])
  const active = Boolean(enabled && chatId && ownerId)
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>()

  useEffect(() => {
    if (!active) return
    const references: PendingMediaDelivery[] = JSON.parse(pendingKey)
    const ids = [...new Set(references.flatMap(delivery => delivery.sourceFileIds))]
      .filter(id => /^[A-Za-z0-9_-]{1,160}$/.test(id))
    if (!ids.length) return
    let disposed = false
    let poll: SerializedPreviewPollController | null = null
    const current = () => !disposed && document.visibilityState !== "hidden"
    const stop = () => { poll?.stop(); poll = null }
    const start = () => {
      stop()
      if (!current()) return
      let first = true
      let consecutiveErrors = 0
      const startedAt = Date.now()
      poll = startSerializedPreviewPoll({
        intervalMs: 5_000,
        isCurrent: current,
        read: async signal => {
          const rows: Record<string, ProcessingRow> = {}
          for (let index = 0; index < ids.length; index += 50) {
            if (signal.aborted) throw new DOMException("Status read detached", "AbortError")
            const batch = ids.slice(index, index + 50)
            const response = await apiClient.getFilesProcessingStatus(batch, { signal })
            if (!Array.isArray(response?.files)) throw new Error("Invalid processing status response")
            for (const row of response.files as ProcessingRow[]) {
              const id = typeof row?.id === "string" ? row.id : ""
              if (batch.includes(id)) rows[id] = row
            }
          }
          return rows
        },
        onValue: rows => {
          consecutiveErrors = 0
          setSnapshot({ key, rows, unavailable: false })
          // A ready source still needs its delivery message. The chat refresh
          // owns that final transition; file status must not claim delivery.
          return !ids.every(id => ["ready", "failed"].includes(String(rows[id]?.processingStage)))
        },
        onError: (error: unknown) => {
          if ((error as { name?: string })?.name === "AbortError") return false
          consecutiveErrors += 1
          setSnapshot(previous => ({ key, rows: previous?.key === key ? previous.rows : {}, unavailable: true }))
          const status = (error as { status?: number; statusCode?: number })?.status
            ?? (error as { statusCode?: number })?.statusCode
          return ![401, 403, 404, 410].includes(status || 0)
        },
        schedule: (callback, delay) => {
          const nextDelay = first ? 0 : consecutiveErrors > 0
            ? Math.min(60_000, 5_000 * (2 ** Math.min(4, consecutiveErrors - 1)))
            : Math.max(delay, Date.now() - startedAt >= 120_000 ? 15_000 : 5_000)
          first = false
          return setTimeout(callback, nextDelay)
        },
        clear: timer => clearTimeout(timer),
      })
    }
    const visibility = () => { if (document.visibilityState === "hidden") stop(); else start() }
    start()
    document.addEventListener("visibilitychange", visibility)
    window.addEventListener("focus", start)
    window.addEventListener("online", start)
    return () => {
      disposed = true
      stop()
      document.removeEventListener("visibilitychange", visibility)
      window.removeEventListener("focus", start)
      window.removeEventListener("online", start)
    }
  }, [active, key, pendingKey])

  return useMemo(() => active ? Object.fromEntries(pending.map(delivery => [
    delivery.messageId, progressFor(delivery, snapshot?.key === key ? snapshot : undefined),
  ])) : {}, [active, pending, snapshot, key])
}
