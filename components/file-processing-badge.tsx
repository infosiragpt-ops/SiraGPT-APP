"use client"

import * as React from "react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { Check, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useFileProcessingStatus, describeStage, type FileProcessingStatus } from "@/hooks/use-file-processing-status"
import { shouldFireReadyTransition, stageProgressPercent, type FileProcessingStage } from "@/lib/file-processing-vocab"

interface Props {
  fileId: string | null | undefined
  /** Compact rendering suitable for image-chip overlays. */
  compact?: boolean
  className?: string
  /**
   * Fires once when the file's stage transitions to `ready` from any
   * other non-ready stage. Useful for surfacing a "documento listo"
   * toast in the parent without the parent having to track stage
   * deltas itself. Will NOT fire on first mount when the row was
   * already `ready` (avoids a misleading toast for an old file).
   */
  onReady?: () => void
  /**
   * Emits observed backend state transitions so parent surfaces can keep
   * their local attachment metadata synchronized with the File row.
   */
  onStatusChange?: (status: FileProcessingStatus) => void
}

/**
 * Small inline indicator that mirrors the File row's processing
 * stage. Drops itself entirely while the file is still uploading
 * (no fileId yet) and once the pipeline is `ready` — only progress
 * and failure states earn screen real estate. Errors are first-class:
 * the failure reason renders inline so the user knows whether the
 * parser, embedding, vector store, or the model itself broke.
 */
export function FileProcessingBadge({ fileId, compact, className, onReady, onStatusChange }: Props) {
  const status = useFileProcessingStatus(fileId)

  // Fire onReady on the non-ready → ready transition. The decision
  // rule lives in `shouldFireReadyTransition` so the edge cases
  // (initial mount on an already-ready file, ready→ready re-renders)
  // can be locked down by unit tests instead of by careful reading.
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

  if (!fileId) return null
  // Don't blink during the first poll.
  if (status.pending) return null
  // Only show once we know we're past the synchronous upload window.
  if (!status.stage) return null
  // Ready files don't deserve a badge — the chip is enough.
  if (status.stage === "ready") return null

  const { label, tone } = describeStage(status.stage, status.error)
  const progress = stageProgressPercent(status.stage)

  const palette = {
    progress: "text-muted-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    neutral: "text-muted-foreground",
  }[tone]

  const Icon = tone === "error"
    ? AlertTriangle
    : tone === "success"
      ? Check
      : null

  return (
    <span
      className={cn(
        "inline-flex min-w-0 flex-col gap-1 leading-none",
        compact ? "w-[5.75rem] text-[10px]" : "w-full max-w-[220px] text-[11px]",
        palette,
        className,
      )}
      title={tone === "error" && status.error ? status.error : label}
    >
      <span className="inline-flex min-w-0 items-center gap-1">
        {Icon ? (
          <Icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
        ) : (
          <ThinkingIndicator size="sm" className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="block h-[2px] w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-white/10" aria-hidden="true">
        <span
          className={cn(
            "block h-full rounded-full transition-[width,background-color] duration-500 ease-out",
            tone === "error" ? "bg-red-500" : "bg-zinc-900/75 dark:bg-white/75",
          )}
          style={{ width: `${progress}%` }}
        />
      </span>
    </span>
  )
}

export default FileProcessingBadge
