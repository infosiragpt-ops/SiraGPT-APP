"use client"

import * as React from "react"
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

import { ClaudeAsterisk } from "@/components/claude-asterisk"
import { cn } from "@/lib/utils"

/**
 * The Claude-style activity rail: a thin vertical line, one small outline
 * icon tile per step (document, terminal, image, search…) and a quiet grey
 * label. Status is carried by the tile, not by coloured text:
 *   running → the small animated asterisk in the think accent
 *   done    → grey outline icon
 *   failed  → the same icon in the muted failure tint
 * Used by the document runner, the agentic loop and the run trace so every
 * "what is it doing" surface reads the same.
 */

export type TraceRailStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "error" | "muted"

const ICON_HINTS: Array<[RegExp, LucideIcon]> = [
  [/imagen|image|foto|render|gr[aá]fic|diagram|logo|portada|thumbnail|miniatura/i, ImageIcon],
  [/c[oó]digo|code|terminal|comando|command|script|compil|build|npm|bun|python|ejecut|exec|test|deploy|shell|bash/i, SquareTerminal],
  [/web|url|navegand|browsing|fetch|http|sitio|p[aá]gina|internet/i, Globe],
  [/busc|search|consult|recuper|retriev|rag|evidencia|fuente|index/i, Search],
  [/documento|document|archivo|file|pdf|docx|word|excel|xlsx|pptx|present|leyendo|reading|adjunto|transcri/i, FileText],
  [/redact|escrib|writing|draft|borrador|respuesta|answer|final|entreg|generando texto/i, PenLine],
  [/sintetiz|synth|resum|summar|plan|organiz|estructur|verific|check/i, ListTree],
]

const PHASE_ICON: Record<string, LucideIcon> = {
  analizando: Sparkles,
  leyendo_documento: FileText,
  sintetizando: ListTree,
  redactando: PenLine,
}

/** Pick the outline glyph for a step from its tool/label first, then its phase. */
export function iconForStep({ label, tool, phase }: { label?: string | null; tool?: string | null; phase?: string | null }): LucideIcon {
  const hay = [tool, label].filter(Boolean).join(" ")
  for (const [re, icon] of ICON_HINTS) if (re.test(hay)) return icon
  return (phase && PHASE_ICON[phase]) || Sparkles
}

export function TraceRail({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative mt-1 flex flex-col gap-1.5 pl-0.5",
        // the rail: a 1px line behind the tiles
        "before:pointer-events-none before:absolute before:bottom-2.5 before:left-[10.5px] before:top-2.5 before:w-px before:bg-border/70",
        className,
      )}
      data-trace-rail="1"
    >
      {children}
    </div>
  )
}

export type TraceRailRowProps = {
  label: React.ReactNode
  status?: TraceRailStatus
  icon?: LucideIcon
  /** Hints for the default icon when `icon` is not given. */
  tool?: string | null
  phase?: string | null
  labelText?: string | null
  detail?: React.ReactNode
  count?: number
  className?: string
  children?: React.ReactNode
}

export function TraceRailRow({ label, status = "done", icon, tool, phase, labelText, detail, count, className, children }: TraceRailRowProps) {
  const failed = status === "failed" || status === "error"
  const running = status === "running"
  const Icon = icon || iconForStep({ label: labelText ?? (typeof label === "string" ? label : null), tool, phase })
  return (
    <div className={cn("relative flex items-start gap-2.5", className)} data-trace-row={status}>
      <span
        className={cn(
          "relative z-[1] mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border bg-background",
          failed ? "border-[color-mix(in_srgb,var(--step-failed,#B45353)_45%,transparent)] text-[var(--step-failed,#B45353)]" : "border-border/70 text-muted-foreground",
          running && "border-[color-mix(in_srgb,var(--think-accent,#D97757)_40%,transparent)]",
        )}
        aria-hidden="true"
      >
        {running ? <ClaudeAsterisk size={12} active /> : <Icon className="h-3 w-3" strokeWidth={1.75} />}
      </span>
      <div className="min-w-0 flex-1 py-px">
        <div
          className={cn(
            "text-[12.5px] leading-5",
            running ? "font-medium text-foreground/85" : "text-muted-foreground",
            failed && "text-foreground/80",
          )}
        >
          {label}
          {count && count > 1 ? <span className="ml-1.5 text-[10.5px] text-muted-foreground/60">×{count}</span> : null}
        </div>
        {detail ? <div className="mt-0.5 max-w-[48rem] text-[12px] leading-5 text-muted-foreground/65">{detail}</div> : null}
        {children}
      </div>
    </div>
  )
}

export default TraceRail
