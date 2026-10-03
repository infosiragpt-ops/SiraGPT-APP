"use client"

import * as React from "react"
import { toast } from "sonner"
import type { RequestBriefPayload } from "@/lib/api"
import { setComposerPrefill } from "@/lib/chat/chat-actions"
import { cn } from "@/lib/utils"

/** Composer text «Corregir» starts: the user completes the sentence. */
export const REQUEST_BRIEF_CORRECTION_PREFILL = "No era eso. Lo que quiero es: "

/**
 * «Entendí: …» under an assistant turn: what the backend understood from the
 * message (request-brief frame live, `metadata.requestBrief` after a reload)
 * with a one-click correction that pre-fills the composer. Small talk and
 * continuations (`trivial`) show nothing. Monochrome; no icons.
 */
export function RequestBriefLine({
  brief,
  live = false,
  className,
}: {
  brief: RequestBriefPayload | null | undefined
  /** The answer is still streaming: the correction waits for the end. */
  live?: boolean
  className?: string
}) {
  if (!brief || brief.trivial || !brief.summary) return null
  const summary = String(brief.summary).trim()
  if (!summary) return null
  const note = brief.ambiguity?.note ? String(brief.ambiguity.note).trim() : ""
  const lowConfidence = typeof brief.confidence === "number" && brief.confidence < 0.7

  const onCorrect = () => {
    setComposerPrefill(REQUEST_BRIEF_CORRECTION_PREFILL)
    toast.message("Dime qué querías y lo rehago.", { duration: 2500 })
  }

  return (
    <div
      data-testid="request-brief-line"
      data-brief-action={brief.action}
      data-brief-target={brief.target?.kind || "none"}
      className={cn(
        "request-brief-line mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] leading-5 text-muted-foreground",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="font-medium text-foreground/80">Entendí:</span>{" "}
        <span className="request-brief-line__summary">{summary}</span>
        {note ? <span className="request-brief-line__note"> · {note}</span> : null}
      </span>
      {!live ? (
        <button
          type="button"
          onClick={onCorrect}
          className={cn(
            "request-brief-line__fix inline-flex h-5 items-center rounded-full border border-border/60 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            lowConfidence && "border-foreground/30 text-foreground/80",
          )}
          aria-label="Corregir lo que entendí"
        >
          Corregir
        </button>
      ) : null}
    </div>
  )
}

/** Live `message.requestBrief`, or the persisted `metadata.requestBrief` of a reloaded row. */
export function extractRequestBrief(message: any): RequestBriefPayload | null {
  if (message?.requestBrief && typeof message.requestBrief === "object") return message.requestBrief as RequestBriefPayload
  try {
    const meta = typeof message?.metadata === "string"
      ? JSON.parse(message.metadata)
      : (message?.metadata && typeof message.metadata === "object" ? message.metadata : null)
    const raw = meta?.requestBrief
    if (raw && typeof raw === "object" && typeof raw.summary === "string" && typeof raw.action === "string") {
      return raw as RequestBriefPayload
    }
  } catch {
    /* malformed metadata */
  }
  return null
}
