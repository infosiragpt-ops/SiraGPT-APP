"use client"

import * as React from "react"

import {
  useFileProcessingStatus,
  type FileProcessingStatus,
} from "@/hooks/use-file-processing-status"
import {
  shouldFireReadyTransition,
  type FileProcessingStage,
} from "@/lib/file-processing-vocab"

interface Props {
  fileId: string | null | undefined
  onReady?: () => void
  onStatusChange?: (status: FileProcessingStatus) => void
}

/**
 * Headless poller. PDF/Office composer chips render DocumentPageThumb
 * instead of FileUploadProgress, so they still need this to push
 * processing-status into the parent attachment record.
 */
export function FileProcessingStatusSync({
  fileId,
  onReady,
  onStatusChange,
}: Props) {
  const status = useFileProcessingStatus(fileId)
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

  return null
}

export default FileProcessingStatusSync
