"use client"

/**
 * PlotlyChart — react-plotly.js wrapper with the basic Plotly bundle.
 *
 * We use `plotly.js-basic-dist-min` (~900 KB gz) instead of the full
 * dist (~4 MB) since the basic bundle already covers scatter/line/bar/
 * pie/heatmap/box — the shapes the viz generator actually emits.
 *
 * The Plotly factory pattern is required because react-plotly.js is
 * CommonJS-only and default-imports don't tree-shake the node build.
 */

import * as React from "react"
import createPlotlyComponent from "react-plotly.js/factory"
import Plotly from "plotly.js-basic-dist-min"

const Plot = createPlotlyComponent(Plotly as any)

export function PlotlyChart({ data, layout }: { data: any[]; layout: any }) {
  const baseLayout = React.useMemo(() => ({
    template: "simple_white",
    margin: { l: 48, r: 24, t: 48, b: 48 },
    font: { family: "Inter, system-ui, sans-serif", size: 12 },
    autosize: true,
    ...layout,
  }), [layout])

  return (
    <div className="w-full h-full">
      <Plot
        data={data}
        layout={baseLayout}
        config={{
          displaylogo: false,
          responsive: true,
          modeBarButtonsToRemove: ["lasso2d", "select2d"],
        }}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  )
}
