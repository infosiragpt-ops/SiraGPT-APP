"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { TurnFailureCause } from "@/lib/admin/turn-failures-types"
import { cn } from "@/lib/utils"
import {
  categoryLabel,
  formatRelative,
  severityBadgeClass,
  severityDotClass,
  trendLabel,
} from "./turn-failure-labels"

export type CauseWindow = "24h" | "7d"

/**
 * «Causas principales» — the improvement backlog: failures grouped by cause
 * with count, trend vs the previous period, affected users and example
 * turns (click → full detail).
 */
export function TopCausesPanel({
  causes,
  window,
  onWindowChange,
  onOpenExample,
  loading = false,
}: {
  causes: { "24h": TurnFailureCause[]; "7d": TurnFailureCause[] } | null
  window: CauseWindow
  onWindowChange: (w: CauseWindow) => void
  onOpenExample: (id: string) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState<string | null>(null)
  const list = causes ? causes[window] || [] : []
  return (
    <section className="rounded-lg border border-border/70 bg-background" data-testid="turn-failure-causes">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Causas principales</h3>
          <p className="text-xs text-muted-foreground">Qué está fallando más, agrupado por causa. Es la lista de mejoras de la plataforma.</p>
        </div>
        <div className="inline-flex rounded-md border border-border/70 p-0.5 text-xs" role="tablist" aria-label="Periodo">
          {(["24h", "7d"] as CauseWindow[]).map((w) => (
            <button
              key={w}
              type="button"
              role="tab"
              aria-selected={window === w}
              onClick={() => onWindowChange(w)}
              className={cn("rounded px-2.5 py-1 font-medium", window === w ? "bg-zinc-900 text-white" : "text-muted-foreground hover:text-foreground")}
            >
              {w === "24h" ? "Últimas 24 h" : "Últimos 7 días"}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {loading ? "Cargando…" : "Sin fallos en este periodo."}
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {list.map((c) => {
            const trend = trendLabel(c.trendPct, c.isNew)
            const expanded = open === c.fingerprint
            return (
              <li key={c.fingerprint}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : c.fingerprint)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
                  aria-expanded={expanded}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", severityDotClass(c.severity))} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.cause || categoryLabel(c.category, c.categoryLabel)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {categoryLabel(c.category, c.categoryLabel)} · {c.affectedUsers} usuario{c.affectedUsers === 1 ? "" : "s"}
                      {c.topModels[0] ? ` · ${c.topModels[0].model}` : ""} · {formatRelative(c.lastAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
                      trend.tone === "up" && "bg-red-50 text-red-700",
                      trend.tone === "down" && "bg-emerald-50 text-emerald-700",
                      trend.tone === "new" && "bg-amber-50 text-amber-800",
                      trend.tone === "flat" && "bg-zinc-100 text-zinc-600",
                    )}
                    title={`Periodo anterior: ${c.previousCount}`}
                  >
                    {trend.text}
                  </span>
                  <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums">{c.count}</span>
                </button>
                {expanded && (
                  <div className="space-y-1.5 bg-muted/20 px-11 pb-3 pt-1">
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <span className={cn("rounded-full border px-2 py-0.5", severityBadgeClass(c.severity))}>{categoryLabel(c.category, c.categoryLabel)}</span>
                      {c.topModels.map((m) => (
                        <span key={m.model} className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-muted-foreground">{m.model} · {m.count}</span>
                      ))}
                    </div>
                    <p className="text-xs font-medium text-muted-foreground">Ejemplos</p>
                    <ul className="space-y-1">
                      {c.examples.map((ex) => (
                        <li key={ex.id}>
                          <button
                            type="button"
                            onClick={() => onOpenExample(ex.id)}
                            className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-background"
                          >
                            <span className="text-muted-foreground">{formatRelative(ex.createdAt)} · {ex.userEmail || "usuario"} · </span>
                            <span className="text-foreground">{ex.prompt || "(sin texto)"}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
