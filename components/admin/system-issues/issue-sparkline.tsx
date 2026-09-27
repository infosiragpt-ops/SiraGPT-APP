"use client"

import { cn } from "@/lib/utils"

/**
 * Events per hour as tiny bars (oldest → newest). Pure SVG: no chart lib,
 * crisp in light and dark mode (bars use currentColor).
 */
export function IssueSparkline({
  values,
  width = 96,
  height = 24,
  className,
  label,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
  label?: string
}) {
  const data = Array.isArray(values) && values.length ? values : [0]
  const max = Math.max(1, ...data)
  const gap = 1
  const barW = Math.max(1, (width - gap * (data.length - 1)) / data.length)
  const total = data.reduce((n, v) => n + (Number(v) || 0), 0)
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label || `${total} eventos en las últimas ${data.length} horas`}
      className={cn("shrink-0 text-red-500/80 dark:text-red-400/80", className)}
      data-testid="issue-sparkline"
    >
      {data.map((v, i) => {
        const h = v > 0 ? Math.max(2, Math.round((v / max) * (height - 1))) : 1
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={0.5}
            className={v > 0 ? "fill-current" : "fill-current opacity-15"}
          />
        )
      })}
    </svg>
  )
}
