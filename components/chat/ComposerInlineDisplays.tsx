"use client"

/**
 * Small presentational components used by the canonical chat composer.
 *
 * Components included:
 *   - ImageAspectRatioMark — small visual chip showing 1:1 / 16:9 / …
 *   - SelectedTextDisplay  — "AI Rewrite" callout above the composer
 *   - ComposerDocumentRow — compact document name, state, and actions
 */

import * as React from "react"
import { FileText, RefreshCw, X } from "lucide-react"
import { AccessibleIconButton } from "@/components/ui/accessible-icon-button"
import { OfficeFileIcon, officeKindFor } from "@/components/office-file-icon"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import type { ComposerDocumentThumbProgress } from "@/lib/file-processing-vocab"
import { cn } from "@/lib/utils"

type ComposerDocumentRowProps = {
  name: string
  mimeType?: string
  details?: string
  uploading: boolean
  progress: ComposerDocumentThumbProgress
  canPreview: boolean
  onOpen: () => void
  onRemove: () => void
  onRetry?: () => void
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>
}

/**
 * A document stays one line; only an unfinished upload or processing needs extra copy.
 * Dense rows set 28/32px targets explicitly, opting out of both the global
 * 44px minimum and its expanding pseudo-element to keep adjacent rows separate.
 */
export function ComposerDocumentRow({
  name,
  mimeType,
  details,
  uploading,
  progress,
  canPreview,
  onOpen,
  onRemove,
  onRetry,
  onKeyDown,
}: ComposerDocumentRowProps) {
  const kind = officeKindFor({ name, mimeType })
  const title = [name, details, progress.label].filter(Boolean).join(" · ")

  return (
    <div
      className="group/document flex min-h-8 w-full max-w-[30rem] items-center gap-1 rounded-md px-1 hover:bg-muted/50 focus-within:bg-muted/50 sm:min-h-7"
      data-testid="composer-document-row"
    >
      <button
        type="button"
        data-no-tap-target="true"
        className="no-tap-expand flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default sm:min-h-7"
        aria-label={`Abrir ${name}`}
        aria-disabled={!canPreview}
        title={title}
        onClick={() => { if (canPreview) onOpen() }}
        onKeyDown={onKeyDown}
      >
        {kind
          ? <OfficeFileIcon kind={kind} size={16} className="h-4 w-4" />
          : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {progress.label && (
        <span
          className={cn(
            "flex max-w-[42%] shrink-0 items-center gap-1 text-[10.5px] leading-4",
            progress.failed ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
          )}
          title={progress.label}
          aria-live="polite"
          aria-atomic="true"
        >
          {progress.busy && <ThinkingIndicator size="xs" label={progress.label} />}
          <span className="truncate">{progress.label}</span>
        </span>
      )}
      {progress.failed && onRetry && (
        <button
          type="button"
          data-no-tap-target="true"
          className="no-tap-expand inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-600 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-red-400 sm:h-7 sm:w-7"
          aria-label={`Reintentar ${name}`}
          title="Reintentar subida"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        data-no-tap-target="true"
        className="no-tap-expand inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover/document:opacity-100 sm:group-focus-within/document:opacity-100"
        aria-label={`${uploading ? "Cancelar subida de" : "Quitar"} ${name}`}
        title={uploading ? "Cancelar subida" : "Quitar archivo"}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}

export type ImageAspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "9:16" | "4:3" | "16:9"

export function ImageAspectRatioMark({
  ratio,
  selected = false,
  className,
}: {
  ratio: ImageAspectRatio
  selected?: boolean
  className?: string
}) {
  const [width, height] = ratio.split(":").map(Number)
  const landscape = width > height
  const portrait = height > width

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-[4px] border border-current/75 bg-background/70",
        landscape ? "h-3 w-5" : portrait ? "h-5 w-3" : "h-4 w-4",
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", selected ? "bg-current" : "bg-current/60")} />
    </span>
  )
}

export const SelectedTextDisplay = ({ text, onClear }: { text: string | null; onClear: () => void }) => {
  if (!text) return null
  return (
    <div className="px-3 pt-3">
      <div className="relative rounded-lg border bg-muted/30 p-3">
        <div className="text-xs font-semibold mb-1 text-muted-foreground">AI Rewrite</div>
        <p className="max-h-24 overflow-y-auto pr-12 text-sm sm:pr-8">{text}</p>
        <AccessibleIconButton
          label="Quitar texto seleccionado"
          className="absolute right-0 top-0 sm:right-1 sm:top-1"
          onClick={onClear}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </AccessibleIconButton>
      </div>
    </div>
  )
}
