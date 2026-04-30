"use client"

import * as React from "react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { Check, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useFileProcessingStatus, describeStage } from "@/hooks/use-file-processing-status"

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
}

/**
 * Small inline indicator that mirrors the File row's processing
 * stage. Drops itself entirely while the file is still uploading
 * (no fileId yet) and once the pipeline is `ready` — only progress
 * and failure states earn screen real estate. Errors are first-class:
 * the failure reason renders inline so the user knows whether the
 * parser, embedding, vector store, or the model itself broke.
 */
export function FileProcessingBadge({ fileId, compact, className, onReady }: Props) {
  const status = useFileProcessingStatus(fileId)

  // Fire onReady on the non-ready → ready transition. Tracking the
  // previous stage in a ref means we never fire from the initial poll
  // that lands directly on 'ready' (legacy file or already-indexed).
  const prevStageRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    const prev = prevStageRef.current
    if (status.stage === "ready" && prev && prev !== "ready") {
      onReady?.()
    }
    if (status.stage) prevStageRef.current = status.stage
  }, [status.stage, onReady])

  if (!fileId) return null
  // Don't blink during the first poll.
  if (status.pending) return null
  // Only show once we know we're past the synchronous upload window.
  if (!status.stage) return null
  // Ready files don't deserve a badge — the chip is enough.
  if (status.stage === "ready") return null

  const { label, tone } = describeStage(status.stage, status.error)

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
        "inline-flex items-center gap-1 leading-none",
        compact ? "text-[10px]" : "text-[11px]",
        palette,
        className,
      )}
      title={tone === "error" && status.error ? status.error : label}
    >
      {Icon ? (
        <Icon className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      ) : (
        <ThinkingIndicator size="sm" className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      )}
      <span className="truncate max-w-[200px]">{label}</span>
    </span>
  )
}

export default FileProcessingBadge
