"use client"

import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useFileProcessingStatus, type FileProcessingStatus } from "@/hooks/use-file-processing-status"
import {
  describeStage,
  shouldFireReadyTransition,
  stageProgressPercent,
  type FileProcessingStage,
} from "@/lib/file-processing-vocab"

interface Props {
  /** True while the HTTP upload is still in flight. */
  uploading: boolean
  /** 0..100 progress of the HTTP upload (only meaningful while `uploading`). */
  uploadProgress?: number
  /** Backend File id — drives the server-side processing phase once known. */
  fileId: string | null | undefined
  onReady?: () => void
  onStatusChange?: (status: FileProcessingStatus) => void
  className?: string
}

/**
 * One continuous progress bar for a document chip across BOTH phases:
 * the HTTP upload (first half, 0..50%) and the server processing /
 * indexing pipeline (second half, 50..100%). A single bar with a single
 * colour the whole way through — so a document never looks like it
 * "loads twice" (the old UX showed a celeste upload bar that completed,
 * then a separate grey processing bar that restarted from zero, which
 * read as a double reload).
 *
 * The handoff between phases holds at ~50% so the bar never jumps
 * backwards or blinks out while we wait for the first processing-status
 * poll. It only disappears once the document is `ready`; failures render
 * in red with the inline reason.
 */
export function FileUploadProgress({
  uploading,
  uploadProgress = 0,
  fileId,
  onReady,
  onStatusChange,
  className,
}: Props) {
  // Only poll once the upload has finished and we have an id — there's
  // no File row to poll while the bytes are still in flight.
  const status = useFileProcessingStatus(uploading ? null : fileId)

  // Fire onReady on the real non-ready → ready edge (same rule the badge
  // uses) so the parent can surface a "documento listo" toast.
  const prevStageRef = React.useRef<FileProcessingStage | null>(null)
  React.useEffect(() => {
    if (shouldFireReadyTransition(prevStageRef.current, status.stage)) {
      onReady?.()
    }
    if (status.stage) prevStageRef.current = status.stage
  }, [status.stage, onReady])

  const lastStatusKeyRef = React.useRef("")
  React.useEffect(() => {
    if (!status.fileId || status.pending || !status.stage) return
    const key = `${status.fileId}:${status.stage}:${status.error || ""}:${status.stageAt || ""}`
    if (lastStatusKeyRef.current === key) return
    lastStatusKeyRef.current = key
    onStatusChange?.(status)
  }, [status, onStatusChange])

  // Nothing to show before an upload starts and before we have an id.
  if (!uploading && !fileId) return null
  // Processing finished cleanly — the chip alone is enough.
  if (!uploading && status.stage === "ready") return null

  // Processing failure stays first-class: red bar + inline reason.
  if (!uploading && status.stage === "failed") {
    const { label } = describeStage(status.stage, status.error)
    return (
      <span
        className={cn(
          "inline-flex min-w-0 flex-col gap-1 leading-none text-red-600 dark:text-red-400 w-full max-w-[220px] text-[11px]",
          className,
        )}
        title={status.error || label}
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span className="truncate">{label}</span>
        </span>
        <span
          className="block h-[3px] w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/10"
          aria-hidden="true"
        >
          <span className="block h-full rounded-full bg-red-500" style={{ width: "100%" }} />
        </span>
      </span>
    )
  }

  // Combined, monotonic progress: upload owns 0..50, processing owns
  // 50..100. The handoff (upload done → first poll pending) holds at 50
  // so the single bar only ever moves forward.
  let pct: number
  if (uploading) {
    pct = Math.min(50, (Math.max(0, uploadProgress) / 100) * 50)
  } else if (status.pending || !status.stage) {
    pct = 50
  } else {
    pct = 50 + (stageProgressPercent(status.stage) / 100) * 50
  }

  const label = uploading ? "Subiendo" : describeStage(status.stage, status.error).label

  return (
    <span
      className={cn("block min-w-0 w-full max-w-[220px]", className)}
      title={label}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <span className="block h-[3px] w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-white/10">
        <span
          className="block h-full rounded-full bg-zinc-900/70 transition-[width] duration-500 ease-out dark:bg-white/70"
          style={{ width: `${Math.max(6, pct)}%` }}
        />
      </span>
    </span>
  )
}

export default FileUploadProgress
