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
 * Finder-like rows retain the end of long names, including their extension.
 * Dense rows set 24/32px targets explicitly, opting out of both the global
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
  const statusId = React.useId()
  // Split by code point, keeping the suffix intact without changing the real name.
  // Flex ellipsis only affects the prefix when the available width is exhausted.
  const characters = Array.from(name)
  const extensionIndex = name.lastIndexOf(".")
  const suffixLength = Math.max(12, extensionIndex > 0 ? Array.from(name.slice(extensionIndex)).length : 0)
  const splitName = characters.length > 32 && suffixLength < characters.length / 2
  const prefix = splitName ? characters.slice(0, -suffixLength).join("") : name
  const suffix = splitName ? characters.slice(-suffixLength).join("") : ""

  return (
    <div
      className="group/document w-full max-w-[16rem] rounded-md px-1 hover:bg-muted/50 focus-within:bg-muted/50"
      data-testid="composer-document-row"
    >
      <div className="flex h-8 min-w-0 items-center gap-1 sm:h-6">
        <button
          type="button"
          data-no-tap-target="true"
          className="no-tap-expand flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default sm:h-6"
          aria-label={`Abrir ${name}`}
          aria-describedby={progress.label ? statusId : undefined}
          aria-disabled={!canPreview}
          title={title}
          onClick={() => { if (canPreview) onOpen() }}
          onKeyDown={onKeyDown}
        >
          {kind
            ? <OfficeFileIcon kind={kind} size={16} className="h-4 w-4 shrink-0" />
            : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0" aria-hidden="true" data-testid="composer-document-name">
            <span className="min-w-0 truncate">{prefix}</span>
            {suffix && <span className="shrink-0">{suffix}</span>}
          </span>
        </button>
        <span className="inline-flex w-3.5 shrink-0 items-center justify-center" title={progress.label}>
          {progress.busy && <ThinkingIndicator size="xs" label={progress.label} />}
        </span>
        {progress.failed && onRetry && (
          <button
            type="button"
            data-no-tap-target="true"
            className="no-tap-expand inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-red-600 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-red-400 sm:h-6 sm:w-6"
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
          className="no-tap-expand inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-6 sm:w-6 sm:[@media(hover:hover)]:opacity-0 sm:group-hover/document:opacity-100 sm:group-focus-within/document:opacity-100"
          aria-label={`${uploading ? "Cancelar subida de" : "Quitar"} ${name}`}
          title={uploading ? "Cancelar subida" : "Quitar archivo"}
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      {progress.label && (
        <span
          id={statusId}
          className={progress.failed
            ? "block pb-1 pl-[22px] text-xs leading-4 text-red-600 dark:text-red-400"
            : "sr-only"}
          aria-live="polite"
          aria-atomic="true"
        >
          {progress.label}
        </span>
      )}
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
