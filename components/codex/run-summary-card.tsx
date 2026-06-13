"use client"

// codex/run-summary-card — "Worked for N minutes" (feature 11). Five real
// metrics from CodexRunMetric; Agent Usage shows the list price struck through
// → the applied price (only when they differ), with an "estimado" badge when
// costSource === 'estimated'. Collapsible to one line.

import React, { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Clock, ListChecks, BookOpen, GitCompare, DollarSign } from "lucide-react"
import { humanizeDuration, formatUsd, shouldStrikethrough } from "@/lib/codex/format"
import type { CodexRunMetric } from "@/lib/codex/codex-api"

export function RunSummaryCard({ metrics }: { metrics: Partial<CodexRunMetric> }) {
  const t = useTranslations("codex")
  const [open, setOpen] = useState(true)
  const m = metrics || {}
  const worked = humanizeDuration(m.timeWorkedMs ?? 0)
  const strike = shouldStrikethrough(m.costOriginalUsd ?? 0, m.costAppliedUsd ?? 0)
  const estimated = m.costSource === "estimated"

  return (
    <div className="my-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        <span className="text-sm font-semibold text-zinc-100">{t("summary.workedFor", { duration: worked })}</span>
      </button>

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <Metric icon={Clock} label={t("summary.timeWorked")} value={worked} />
          <Metric icon={ListChecks} label={t("summary.workDone")} value={t("summary.actions", { count: m.actionsCount ?? 0 })} />
          <Metric icon={BookOpen} label={t("summary.itemsRead")} value={t("summary.lines", { count: m.itemsReadLines ?? 0 })} />
          <Metric icon={GitCompare} label={t("summary.codeChanged")} value={`+${m.additions ?? 0} −${m.deletions ?? 0}`} />
          <div className="flex items-start gap-1.5">
            <DollarSign className="mt-0.5 h-3.5 w-3.5 text-zinc-500" />
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">{t("summary.agentUsage")}</div>
              <div className="flex items-center gap-1.5 text-zinc-200">
                {strike && <span className="text-zinc-500 line-through">{formatUsd(m.costOriginalUsd ?? 0)}</span>}
                <span>{formatUsd(m.costAppliedUsd ?? 0)}</span>
                {estimated && <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">{t("summary.estimated")}</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-start gap-1.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 text-zinc-500" />
      <div>
        <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
        <div className="text-zinc-200">{value}</div>
      </div>
    </div>
  )
}
