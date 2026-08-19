"use client"

/**
 * RechartsChart — compiles the viz-generator's compact chart config
 * into a Recharts component tree.
 *
 * Config shape (produced by /api/viz/generate with format=recharts):
 *   {
 *     type: "line"|"bar"|"area"|"pie"|"scatter",
 *     data: [ {...row}, ... ],
 *     xKey: string,
 *     series: [{ key, name, color }],
 *     stacked?: boolean,
 *     height?: number,
 *     colors?: string[]    // used by pie
 *   }
 */

import * as React from "react"
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  AreaChart, Area,
  PieChart, Pie, Cell,
  ScatterChart, Scatter,
  CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from "recharts"

const DEFAULT_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#84cc16", "#f43f5e", "#3b82f6", "#a855f7",
]

export function RechartsChart({ chart }: { chart: any }) {
  if (!chart || !chart.type) {
    return <div className="p-8 text-sm text-muted-foreground">Configuración inválida</div>
  }
  const height = chart.height || 360
  const common = {
    data: chart.data || [],
    margin: { top: 12, right: 16, left: 8, bottom: 8 },
  }

  let inner: React.ReactNode = null
  switch (chart.type) {
    case "line":
      inner = (
        <LineChart {...common}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {(chart.series || []).map((s: any, i: number) => (
            <Line
              key={s.key} type="monotone" dataKey={s.key} name={s.name || s.key}
              stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              strokeWidth={2} dot={false} activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      )
      break
    case "bar":
      inner = (
        <BarChart {...common}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {(chart.series || []).map((s: any, i: number) => (
            <Bar
              key={s.key} dataKey={s.key} name={s.name || s.key}
              fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              stackId={chart.stacked ? "stack" : undefined}
            />
          ))}
        </BarChart>
      )
      break
    case "area":
      inner = (
        <AreaChart {...common}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {(chart.series || []).map((s: any, i: number) => (
            <Area
              key={s.key} type="monotone" dataKey={s.key} name={s.name || s.key}
              stroke={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              fillOpacity={0.2}
              stackId={chart.stacked ? "stack" : undefined}
            />
          ))}
        </AreaChart>
      )
      break
    case "pie": {
      const colors = chart.colors || DEFAULT_COLORS
      inner = (
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie
            data={chart.data || []}
            dataKey="value" nameKey="name"
            innerRadius={60} outerRadius={120}
            paddingAngle={2}
          >
            {(chart.data || []).map((_row: any, i: number) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
        </PieChart>
      )
      break
    }
    case "scatter":
      inner = (
        <ScatterChart {...common}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={chart.xKey} tick={{ fontSize: 11 }} />
          <YAxis dataKey={(chart.series && chart.series[0]?.key) || "y"} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {(chart.series || [{ key: "y", name: "Puntos" }]).map((s: any, i: number) => (
            <Scatter
              key={s.key} name={s.name || s.key}
              data={chart.data || []}
              fill={s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
            />
          ))}
        </ScatterChart>
      )
      break
    default:
      return <div className="p-8 text-sm text-muted-foreground">Tipo no soportado: {chart.type}</div>
  }

  return (
    <div className="w-full h-full p-4">
      <ResponsiveContainer width="100%" height={height}>
        {inner as any}
      </ResponsiveContainer>
    </div>
  )
}
