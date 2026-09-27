"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import {
  FileText,
  Globe,
  Image as ImageIcon,
  ListTree,
  PenLine,
  Search,
  SquareTerminal,
  Sparkles,
  type LucideIcon,
} from "lucide-react"

import { TraceRail, TraceRailRow, type TraceRailStatus } from "@/components/trace-rail"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { formatThinkingDuration } from "@/components/thinking-trace"
import { apiClient } from "@/lib/api"
import type { ActivityKind, ActivityStep } from "@/lib/chat/activity-log"
import { cn } from "@/lib/utils"

/**
 * Timeline of an agent turn whose steps are tool calls (edición milimétrica,
 * docs/specs/edicion-milimetrica/SPEC.md §8): one quiet grey row per tool
 * call on the Claude-style rail — the model's own phrase, the icon of the
 * tool family, the asterisk while it runs — with the page / before-after
 * thumbnail always visible under render and verification steps, and what
 * ran / what came back behind the chevron.
 */

// Terminal frames: the answer itself says the turn ended.
const HIDDEN_STEPS = new Set(["final", "outputs", "job_done"])

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  terminal: SquareTerminal,
  document: FileText,
  image: ImageIcon,
  search: Search,
  web: Globe,
  edit: PenLine,
  check: ListTree,
  thinking: Sparkles,
}

function railStatus(step: ActivityStep, live: boolean): TraceRailStatus {
  if (step.status === "error") return "failed"
  if (step.status === "active" && live) return "running"
  return "done"
}

/**
 * A thumbnail: live frames are data: URLs; a reloaded turn keeps artifact
 * URLs, which need the bearer token, so they load as blobs.
 */
function useThumbSrc(src: string): string | null {
  const direct = src.startsWith("data:")
  const [resolved, setResolved] = React.useState<string | null>(direct ? src : null)
  React.useEffect(() => {
    if (direct) {
      setResolved(src)
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    apiClient
      .getMediaArtifactBlob(src)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setResolved(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setResolved(null)
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, direct])
  return resolved
}

function StepThumb({ src, alt, wide, onOpen }: { src: string; alt: string; wide: boolean; onOpen: (url: string, alt: string) => void }) {
  const resolved = useThumbSrc(src)
  if (!resolved) return null
  return (
    <button
      type="button"
      onClick={() => onOpen(resolved, alt)}
      aria-label={`Ampliar: ${alt}`}
      data-activity-thumb={wide ? "wide" : "page"}
      className={cn(
        "mt-1.5 block cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-background leading-none",
        wide ? "w-full max-w-[400px]" : "max-w-full",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- data: / blob: thumbnail of the user's own document */}
      <img
        src={resolved}
        alt={alt}
        loading="lazy"
        className={cn("block", wide ? "h-auto w-full" : "h-[124px] w-auto max-w-full")}
      />
    </button>
  )
}

function StepRow({ step, live, onOpen }: { step: ActivityStep; live: boolean; onOpen: (url: string, alt: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const status = railStatus(step, live)
  const phrase = step.label
  const details = [step.detail, step.result].filter((part) => part && part.trim()).join("\n\n")
  const expandable = details.length > 0
  const failedNote = status === "failed" ? (step.kind === "check" ? "no pasó" : "falló") : null
  const thumbs = Array.isArray(step.thumbs) ? step.thumbs : []
  const label = (
    <>
      <span className="break-words">{phrase}</span>
      {failedNote ? <span className="ml-1 text-[11.5px] font-medium text-[var(--step-failed,#B45353)]">· {failedNote}</span> : null}
    </>
  )
  return (
    <TraceRailRow
      status={status}
      icon={step.kind ? KIND_ICON[step.kind] : undefined}
      tool={step.tool}
      labelText={phrase}
      label={
        expandable ? (
          <button
            type="button"
            className="inline-flex max-w-full items-start gap-1 text-left hover:text-foreground/85"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="min-w-0">{label}</span>
            <svg
              className={cn("think-chevron mt-[5px] h-3 w-3 shrink-0 opacity-70 transition-transform", open && "rotate-90")}
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          label
        )
      }
    >
      {thumbs.map((src, index) => (
        <StepThumb
          key={`${step.id}-thumb-${index}`}
          src={src}
          alt={phrase}
          wide={step.kind === "check"}
          onOpen={onOpen}
        />
      ))}
      {expandable && open ? (
        <pre
          data-activity-detail="1"
          className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] leading-4 text-muted-foreground"
        >
          {details}
        </pre>
      ) : null}
    </TraceRailRow>
  )
}

export type ActivityRailProps = {
  steps: ActivityStep[]
  /** The turn is still running (the active row shows the asterisk). */
  live: boolean
  durationMs?: number | null
  className?: string
}

export function ActivityRail({ steps, live, durationMs, className }: ActivityRailProps) {
  const t = useTranslations("thinking")
  // Open by default (the thumbnails are the proof of the edit, SPEC §8 E.2);
  // the header folds it.
  const [collapsed, setCollapsed] = React.useState(false)
  const [preview, setPreview] = React.useState<{ url: string; alt: string } | null>(null)
  const rows = React.useMemo(
    () =>
      (Array.isArray(steps) ? steps : []).filter((step) => {
        if (!step || !String(step.label || "").trim()) return false
        if (step.step && HIDDEN_STEPS.has(step.step)) return false
        // «Pensando» ticks between tool calls only show while they are live.
        if (/^pensando/i.test(step.label) && !step.callId) return live && step.status === "active"
        return true
      }),
    [steps, live],
  )
  const openPreview = React.useCallback((url: string, alt: string) => setPreview({ url, alt }), [])
  if (!rows.length) return null
  const summary = durationMs && durationMs > 0 ? t("thoughtFor", { duration: formatThinkingDuration(durationMs) }) : t("thought")
  return (
    <div data-activity-rail="1" className={cn("my-2 w-full max-w-2xl font-sans", className)}>
      {!live ? (
        <button
          type="button"
          className="mb-1 inline-flex items-center gap-1.5 text-[13px] leading-5 text-muted-foreground hover:text-foreground/85"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <svg
            className={cn("think-chevron h-3 w-3 shrink-0 transition-transform", !collapsed && "rotate-90")}
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M6 3.5 11 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{summary}</span>
        </button>
      ) : null}
      {collapsed && !live ? null : (
        <TraceRail>
          {rows.map((step) => (
            <StepRow key={step.id} step={step} live={live} onOpen={openPreview} />
          ))}
        </TraceRail>
      )}
      <Dialog open={Boolean(preview)} onOpenChange={(value) => { if (!value) setPreview(null) }}>
        <DialogContent className="max-h-[90vh] max-w-[min(1100px,96vw)] overflow-auto p-3">
          <DialogTitle className="pr-8 text-[13px] font-normal text-muted-foreground">{preview?.alt}</DialogTitle>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- data: / blob: image of the user's own document
            <img src={preview.url} alt={preview.alt} className="block h-auto w-full rounded-md border border-border/70" />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ActivityRail
