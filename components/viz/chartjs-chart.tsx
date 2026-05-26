"use client"

/**
 * ChartJsChart — renders a Chart.js v4 config on an HTMLCanvas.
 *
 * We import the full `chart.js/auto` bundle so the generator doesn't
 * have to worry about registering individual chart types/scales. The
 * component owns the canvas; we destroy + recreate the Chart instance
 * on every config change (Chart.js doesn't reliably swap types in
 * place).
 */

import * as React from "react"
import { Chart, registerables } from "chart.js"

Chart.register(...registerables)

export function ChartJsChart({ config }: { config: any }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const chartRef = React.useRef<Chart | null>(null)

  React.useEffect(() => {
    if (!canvasRef.current) return
    // Destroy previous instance before re-creating — Chart.js doesn't
    // allow two charts on the same canvas.
    if (chartRef.current) {
      try { chartRef.current.destroy() } catch { /* */ }
      chartRef.current = null
    }
    const safeConfig = {
      ...(config || {}),
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom" as const },
          ...(config?.options?.plugins || {}),
        },
        ...(config?.options || {}),
      },
    }
    try {
      chartRef.current = new Chart(canvasRef.current, safeConfig as any)
    } catch (err) {
      console.error("[chartjs] failed to init:", err)
    }
    return () => {
      if (chartRef.current) {
        try { chartRef.current.destroy() } catch { /* */ }
        chartRef.current = null
      }
    }
  }, [config])

  return (
    <div className="w-full h-full p-4">
      <canvas ref={canvasRef} className="!w-full !h-full" />
    </div>
  )
}
