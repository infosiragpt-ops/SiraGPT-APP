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
 * Format a concise secondary metadata label for the composer document card
 * (e.g. "DOCX · 139 KB" or "Legal · TXT · 29 B") without repeating the file name.
 */
function formatCompactDocumentMeta(name: string, kind: ReturnType<typeof officeKindFor>, details?: string): string {
  const parts = String(details || "")
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean)
  const dot = name.lastIndexOf(".")
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : ""
  const shortKind = kind === "word"
    ? (ext || "DOCX")
    : kind === "pdf"
      ? "PDF"
      : kind === "excel"
        ? (ext || "XLSX")
        : kind === "powerpoint"
          ? (ext || "PPTX")
          : kind === "spss"
            ? "SPSS"
            : ext

  if (parts.length === 0) return ""
  const sizePart = parts.find((p) => /^\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB)$/i.test(p))
  const pathPart = parts.find((p) => p.includes("/"))
  const folderLabel = pathPart ? pathPart.split("/").slice(0, -1).join("/") : ""
  const fallbackKind = parts.find((p) => p !== sizePart && p !== pathPart) || ""
  const typeLabel = shortKind || fallbackKind
  return [folderLabel, typeLabel, sizePart].filter(Boolean).join(" · ")
}

/**
 * Professional composer document card: wider readable surface with crisp file
 * badge, middle-truncated long names preserving the extension, subtle format
 * and size metadata, and stable layout across upload/extracting/ready states.
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
  const metaLine = formatCompactDocumentMeta(name, kind, details)
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
      className={cn(
        "group/document w-full max-w-[23.5rem] rounded-xl border border-slate-200/90 bg-slate-50/70 px-3 py-1.5",
        "shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors",
        "hover:border-slate-300/90 hover:bg-slate-50 focus-within:border-slate-300 focus-within:bg-slate-50",
        "dark:border-border/70 dark:bg-muted/30 dark:hover:border-border dark:hover:bg-muted/45",
        "sm:min-w-[16.5rem]",
        progress.failed && "border-red-300/90 bg-red-50/40 dark:border-red-700/60 dark:bg-red-950/20",
      )}
      data-testid="composer-document-row"
    >
      <div className="flex h-9 min-w-0 items-center gap-2">
        <button
          type="button"
          data-no-tap-target="true"
          className="no-tap-expand flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left text-[13.5px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:cursor-default"
          aria-label={`Abrir ${name}`}
          aria-describedby={progress.label ? statusId : undefined}
          aria-disabled={!canPreview}
          title={title}
          onClick={() => { if (canPreview) onOpen() }}
          onKeyDown={onKeyDown}
        >
          {kind
            ? <OfficeFileIcon kind={kind} size={24} className="h-6 w-6 shrink-0" />
            : <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 font-medium text-foreground" aria-hidden="true" data-testid="composer-document-name">
              <span className="min-w-0 truncate">{prefix}</span>
              {suffix && <span className="shrink-0">{suffix}</span>}
            </span>
            {metaLine && (
              <span className="truncate text-[11.5px] leading-4 text-muted-foreground" aria-hidden="true" data-testid="composer-document-meta">
                {metaLine}
              </span>
            )}
          </span>
        </button>
        <span className="inline-flex w-4 shrink-0 items-center justify-center" title={progress.label}>
          {progress.busy && <ThinkingIndicator size="xs" label={progress.label} />}
        </span>
        {progress.failed && onRetry && (
          <button
            type="button"
            data-no-tap-target="true"
            className="no-tap-expand inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-red-600 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:text-red-400 sm:h-6 sm:w-6"
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
          className="no-tap-expand inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-6 sm:w-6 sm:[@media(hover:hover)]:opacity-0 sm:group-hover/document:opacity-100 sm:group-focus-within/document:opacity-100"
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
            ? "block pb-0.5 pl-[34px] text-xs leading-4 text-red-600 dark:text-red-400"
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
