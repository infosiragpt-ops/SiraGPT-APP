"use client"

/**
 * SourceChart — bar chart of source counts per publication year.
 *
 * Small, passive visualization so the user sees at a glance whether
 * their year-range filter yielded a reasonable temporal distribution
 * (e.g. too many old, too few from the past 2 years). Reuses the
 * project's existing Recharts dep — no new dependency introduced.
 */

import * as React from "react"
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts"
import type { MarcoSource } from "@/lib/marco-teorico-service"

interface Props {
  sources: MarcoSource[]
  label?: string
  height?: number
}

export function SourceChart({ sources, label = "Fuentes por año", height = 140 }: Props) {
  const data = React.useMemo(() => {
    const byYear = new Map<number, number>()
    for (const s of sources) {
      if (typeof s.year !== "number") continue
      byYear.set(s.year, (byYear.get(s.year) || 0) + 1)
    }
    const rows = Array.from(byYear.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([year, count]) => ({ year, count }))
    return rows
  }, [sources])

  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
        {label}: —
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card px-3 pt-3 pb-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-1">
        {label}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
          <XAxis
            dataKey="year"
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
            width={28}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number) => [`${v}`, "fuentes"]}
            labelFormatter={(y) => `Año ${y}`}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]}>
            {data.map((_, idx) => (
              <Cell key={idx} fill="hsl(var(--foreground))" fillOpacity={0.7} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
