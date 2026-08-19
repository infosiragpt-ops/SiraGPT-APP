"use client"

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { DIMENSION_META } from "@/lib/builder/dimensions"
import { DIMENSION_ORDER } from "@/lib/builder/useIntake"
import type { Coverage, CoverageDimension } from "@/lib/builder/intake-service"

interface CoverageRailProps {
  coverage: Coverage | null
  active?: CoverageDimension | null
}

const accent = "hsl(var(--accent-violet))"

/** Vertical stepper of the six coverage dimensions with live state. */
export function CoverageRail({ coverage, active }: CoverageRailProps) {
  const covered = new Set(coverage?.covered ?? [])
  const pct = Math.round((coverage?.ratio ?? 0) * 100)

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-4 flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Cobertura
        </span>
        <span className="font-mono text-sm tabular-nums" style={{ color: accent }}>
          {pct}%
        </span>
      </div>

      {DIMENSION_ORDER.map((dim, i) => {
        const meta = DIMENSION_META[dim]
        const Icon = meta.icon
        const isDone = covered.has(dim)
        const isActive = active === dim && !isDone
        return (
          <div key={dim} className="relative flex items-center gap-3 py-2">
            {/* connector */}
            {i < DIMENSION_ORDER.length - 1 && (
              <span
                className={cn("absolute left-[15px] top-[34px] h-[18px] w-px", isDone ? "" : "bg-border")}
                style={isDone ? { background: accent } : undefined}
              />
            )}
            <span
              className={cn(
                "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-all",
                isDone && "border-transparent text-white",
                isActive && "border-transparent",
                !isDone && !isActive && "border-border bg-card text-muted-foreground",
              )}
              style={
                isDone
                  ? { background: accent }
                  : isActive
                    ? { boxShadow: `0 0 0 3px hsl(var(--accent-violet) / 0.25)`, background: "hsl(var(--accent))", color: accent }
                    : undefined
              }
            >
              {isDone ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "truncate text-sm font-medium",
                  isDone || isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {meta.label}
              </p>
              <p className="truncate text-xs text-muted-foreground">{meta.short}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
