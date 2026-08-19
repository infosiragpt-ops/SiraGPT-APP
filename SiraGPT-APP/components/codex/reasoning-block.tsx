"use client"

// codex/reasoning-block — a collapsible chain-of-thought block with a label and
// real duration (feature 10), e.g. "Planning database migration (47 seconds)".
// Streams open; collapses to a one-line summary when it ends. Mirrors
// components/thinking-trace.tsx.

import React, { useState } from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

function formatSeconds(ms?: number): string {
  if (!ms || ms <= 0) return ""
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}` : `${Math.floor(s / 60)} min ${s % 60}`
}

export function ReasoningBlock({ label, text, durationMs, done }: { label: string; text: string; durationMs?: number; done: boolean }) {
  const t = useTranslations("codex")
  const [open, setOpen] = useState(!done)
  const dur = formatSeconds(durationMs)

  return (
    <div className="my-1.5 rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200"
        aria-expanded={open}
      >
        {done ? <Sparkles className="h-3.5 w-3.5 text-violet-400/70" /> : <ThinkingIndicator size="xs" label="Pensando" />}
        <span className="font-medium">{label || t("timeline.reasoning")}</span>
        {dur && <span className="opacity-50">{t("timeline.durationSeconds", { seconds: dur })}</span>}
        <span className="ml-auto">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
      </button>
      {open && text && (
        <div className={clsx("px-3 pb-2 text-xs leading-relaxed text-zinc-400 whitespace-pre-wrap", !done && "animate-pulse")}>{text}</div>
      )}
    </div>
  )
}
