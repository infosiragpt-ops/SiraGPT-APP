"use client"

// codex/run-summary-card — "Worked for N minutes" (feature 11). Five real
// metrics from CodexRunMetric; Agent Usage shows the list price struck through
// → the applied price (only when they differ), with an "estimado" badge when
// costSource === 'estimated'. The Agent Usage cell expands into a per-direction
// detail (model · input/output tokens · input/output/total cost). When a
// `session` accumulator is passed, a footer line shows the running session
// total across every run. Collapsible to one line.

import React, { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Clock, ListChecks, BookOpen, GitCompare, DollarSign } from "lucide-react"
import { humanizeDuration, formatUsd, formatInt, shouldStrikethrough } from "@/lib/codex/format"
import type { CodexRunMetric } from "@/lib/codex/codex-api"

export interface RunSessionUsage {
  costAppliedUsd: number
  costOriginalUsd: number
  tokensIn: number
  tokensOut: number
  runs: number
}

export function RunSummaryCard({ metrics, session }: { metrics: Partial<CodexRunMetric>; session?: RunSessionUsage }) {
  const t = useTranslations("codex")
  const [open, setOpen] = useState(true)
  const [detailOpen, setDetailOpen] = useState(false)
  const m = metrics || {}
  const worked = humanizeDuration(m.timeWorkedMs ?? 0)
  const strike = shouldStrikethrough(m.costOriginalUsd ?? 0, m.costAppliedUsd ?? 0)
  const estimated = m.costSource === "estimated"
  const total = m.costAppliedUsd ?? 0

  return (
    <div className="my-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        <span className="text-sm font-semibold text-zinc-100">{t("summary.workedFor", { duration: worked })}</span>
      </button>

      {open && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Metric icon={Clock} label={t("summary.timeWorked")} value={worked} />
            <Metric icon={ListChecks} label={t("summary.workDone")} value={t("summary.actions", { count: m.actionsCount ?? 0 })} />
            <Metric icon={BookOpen} label={t("summary.itemsRead")} value={t("summary.lines", { count: m.itemsReadLines ?? 0 })} />
            <Metric icon={GitCompare} label={t("summary.codeChanged")} value={`+${m.additions ?? 0} −${m.deletions ?? 0}`} />
            <button
              type="button"
              onClick={() => setDetailOpen((v) => !v)}
              aria-expanded={detailOpen}
              title={t("summary.usageDetail")}
              className="flex items-start gap-1.5 rounded-md text-left hover:bg-white/[0.04]"
            >
              <DollarSign className="mt-0.5 h-3.5 w-3.5 text-zinc-500" />
              <div>
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  {t("summary.agentUsage")}
                  {detailOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </div>
                <div className="flex items-center gap-1.5 text-zinc-200">
                  {strike && <span className="text-zinc-500 line-through">{formatUsd(m.costOriginalUsd ?? 0)}</span>}
                  <span>{formatUsd(total)}</span>
                  {estimated && <span className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] text-amber-300">{t("summary.estimated")}</span>}
                </div>
              </div>
            </button>
          </div>

          {detailOpen && (
            <div className="mt-2 space-y-1 rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-[11px]">
              {m.model && <DetailRow label={t("summary.model")} value={m.model} mono />}
              <DetailRow label={t("summary.inputTokens")} value={formatInt(m.tokensIn ?? 0)} />
              <DetailRow label={t("summary.outputTokens")} value={formatInt(m.tokensOut ?? 0)} />
              <DetailRow label={t("summary.inputCost")} value={formatUsd(m.costInputUsd ?? 0)} />
              <DetailRow label={t("summary.outputCost")} value={formatUsd(m.costOutputUsd ?? 0)} />
              <div className="mt-1 border-t border-white/10 pt-1">
                <DetailRow label={t("summary.totalCost")} value={formatUsd(total)} strong />
              </div>
            </div>
          )}

          {session && session.runs > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-2 text-[11px] text-zinc-400">
              <span>
                {t("summary.thisRun")}: <span className="text-zinc-200">{formatUsd(total)}</span>
              </span>
              <span className="text-zinc-600">·</span>
              <span>
                {t("summary.sessionUsage")}: <span className="text-zinc-200">{formatUsd(session.costAppliedUsd)}</span>{" "}
                <span className="text-zinc-500">({t("summary.sessionRuns", { count: session.runs })})</span>
              </span>
            </div>
          )}
        </>
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

function DetailRow({ label, value, mono, strong }: { label: string; value: string; mono?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={`${mono ? "font-mono" : ""} ${strong ? "font-semibold text-zinc-100" : "text-zinc-200"} truncate`}>{value}</span>
    </div>
  )
}
