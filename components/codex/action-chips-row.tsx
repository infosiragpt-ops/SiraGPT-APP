"use client"

// codex/action-chips-row — a grouped burst of agent actions as a collapsible
// "N actions" chip row (feature 10). Collapsed by default; expanding reveals
// each command/path + its output summary. Failed actions tint red. Mirrors the
// chip/timeline patterns of components/agent-trace.tsx.

import React, { useState } from "react"
import clsx from "clsx"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Terminal, FileText, FilePen, Globe, Sparkles, Check, X } from "lucide-react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { CustomCodeBlock } from "@/components/ui/custom-code-block"
import type { ActionItem } from "@/lib/codex/timeline-reducer"

function iconForKind(kind: string) {
  switch (kind) {
    case "terminal": return Terminal
    case "file_read": return FileText
    case "file_write": return FilePen
    case "web": return Globe
    case "reasoning": return Sparkles
    default: return Terminal
  }
}

function StatusGlyph({ status }: { status: ActionItem["status"] }) {
  if (status === "running") return <ThinkingIndicator size="xs" label="Ejecutando" />
  if (status === "error") return <X className="h-3.5 w-3.5 text-red-400" />
  return <Check className="h-3.5 w-3.5 text-emerald-400" />
}

export function ActionChipsRow({ actions }: { actions: ActionItem[] }) {
  const t = useTranslations("codex")
  const [expanded, setExpanded] = useState(false)
  const running = actions.some((a) => a.status === "running")
  const errored = actions.some((a) => a.status === "error")
  const n = actions.length

  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={clsx(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          errored ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
        )}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="flex -space-x-1">
          {actions.slice(0, 4).map((a, i) => {
            const Icon = iconForKind(a.kind)
            return <Icon key={i} className="h-3.5 w-3.5" />
          })}
        </span>
        <span className="tabular-nums">{t("timeline.actions", { count: n })}</span>
        {running && <ThinkingIndicator size="xs" label="Ejecutando" />}
      </button>

      {expanded && (
        <ul className="mt-1.5 space-y-1.5 border-l border-white/10 pl-3">
          {actions.map((a) => {
            const Icon = iconForKind(a.kind)
            const label = a.command || a.path || a.kind
            return (
              <li key={a.actionId} className="text-xs">
                <div className={clsx("flex items-center gap-1.5", a.status === "error" && "text-red-300")}>
                  <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <code className="truncate font-mono">{label}</code>
                  <span className="ml-auto flex items-center gap-1">
                    {typeof a.durationMs === "number" && a.status !== "running" && (
                      <span className="text-[10px] tabular-nums opacity-50">{Math.round(a.durationMs)}ms</span>
                    )}
                    <StatusGlyph status={a.status} />
                  </span>
                </div>
                {a.outputSummary && a.status !== "running" && (
                  <div className={clsx("mt-1", a.status === "error" && "rounded bg-red-500/5")}>
                    <CustomCodeBlock className="text-[11px]">{a.outputSummary}</CustomCodeBlock>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
