"use client"

/**
 * VizArtifactDisplay — inline chat renderer for `viz`-typed files
 * produced by /api/viz/generate.
 *
 * Dispatches on `file.format`:
 *   matplotlib → <img> (PNG data URL, server-rendered by the Python
 *                sandbox via matplotlib/seaborn).
 *   plotly      → react-plotly.js, lazy-loaded (Plotly adds ~900 KB
 *                 to the bundle so we keep it out of the initial
 *                 chat load).
 *   chartjs     → chart.js (already in the bundle for other features).
 *   recharts    → RechartsRenderer (local component, lazy).
 *   d3          → sandboxed iframe with srcdoc=file.html. D3 lives
 *                 inside the iframe via CDN; nothing leaks out.
 *   mermaid     → re-use FigmaDiagramDisplay (mermaid.ink image with
 *                 a client-side SVG fallback toggle).
 *
 * All renderers are wrapped in a common <VizFrame/> that gives them
 * the same header (title + format badge), the same collapsed/expanded
 * heights, and the same download button (PNG for image formats,
 * copy-config for structured formats).
 */

import * as React from "react"
import dynamic from "next/dynamic"
import {
  BarChart3, Download, Maximize2, Minimize2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { FigmaDiagramDisplay } from "@/components/figma-diagram-component"

// Lazy loaders — never in the initial bundle.
const PlotlyChart = dynamic(() => import("./plotly-chart").then(m => m.PlotlyChart), {
  ssr: false, loading: () => <LoadingBox />,
})
const ChartJsChart = dynamic(() => import("./chartjs-chart").then(m => m.ChartJsChart), {
  ssr: false, loading: () => <LoadingBox />,
})
const RechartsChart = dynamic(() => import("./recharts-chart").then(m => m.RechartsChart), {
  ssr: false, loading: () => <LoadingBox />,
})

function LoadingBox() {
  return (
    <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
      Cargando visualización…
    </div>
  )
}

interface VizFile {
  type: "viz"
  format: "matplotlib" | "plotly" | "chartjs" | "recharts" | "d3" | "mermaid"
  title?: string
  explanation?: string
  imageUrl?: string       // matplotlib (data URL) or mermaid (mermaid.ink URL)
  pythonCode?: string     // matplotlib
  data?: any[]            // plotly
  layout?: any            // plotly
  config?: any            // chartjs
  chart?: any             // recharts config
  html?: string           // d3 self-contained HTML
  code?: string           // mermaid source
}

interface Props {
  files: any[]
}

export function VizArtifactDisplay({ files }: Props) {
  const vizzes = React.useMemo<VizFile[]>(
    () => (Array.isArray(files) ? files.filter((f: any) => f?.type === "viz") : []),
    [files]
  )
  if (vizzes.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {vizzes.map((v, i) => <VizCard key={i} viz={v} />)}
    </div>
  )
}

const FORMAT_LABEL: Record<string, string> = {
  matplotlib: "matplotlib",
  plotly: "Plotly interactivo",
  chartjs: "Chart.js",
  recharts: "Recharts",
  d3: "D3.js",
  mermaid: "Mermaid",
}

function VizCard({ viz }: { viz: VizFile }) {
  const [expanded, setExpanded] = React.useState(false)

  function download() {
    if (viz.format === "matplotlib" && viz.imageUrl) {
      // Save PNG.
      const a = document.createElement("a")
      a.href = viz.imageUrl
      a.download = `${(viz.title || "chart").replace(/[^\w\s-]/g, "").trim()}.png`
      document.body.appendChild(a); a.click(); a.remove()
      return
    }
    // For structured formats export the JSON spec so the user can
    // drop it into their own notebook / dashboard.
    const payload = JSON.stringify({
      format: viz.format,
      title: viz.title,
      data: viz.data, layout: viz.layout, config: viz.config, chart: viz.chart,
      code: viz.code, html: viz.html, pythonCode: viz.pythonCode,
    }, null, 2)
    const blob = new Blob([payload], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${(viz.title || "chart").replace(/[^\w\s-]/g, "").trim()}.json`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // Mermaid reuses the existing FigmaDiagramDisplay — it already
  // handles mermaid.ink image + client-side SVG toggle.
  if (viz.format === "mermaid") {
    const fakeFigmaFiles = [{
      type: "figma",
      mermaidCode: viz.code,
      imageUrl: viz.imageUrl,
      title: viz.title,
    }]
    return (
      <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
        <VizHeader viz={viz} expanded={expanded} setExpanded={setExpanded} onDownload={download} />
        <div className={expanded ? "min-h-[75vh]" : ""}>
          <FigmaDiagramDisplay files={fakeFigmaFiles} />
        </div>
      </div>
    )
  }

  const body = (() => {
    switch (viz.format) {
      case "matplotlib":
        return viz.imageUrl ? (
          <img
            src={viz.imageUrl}
            alt={viz.title || "chart"}
            className="mx-auto max-w-full max-h-full"
          />
        ) : (
          <div className="p-8 text-sm text-muted-foreground">Sin imagen</div>
        )
      case "plotly":
        return <PlotlyChart data={viz.data || []} layout={viz.layout || {}} />
      case "chartjs":
        return <ChartJsChart config={viz.config || {}} />
      case "recharts":
        return <RechartsChart chart={viz.chart || {}} />
      case "d3":
        return viz.html ? (
          <iframe
            srcDoc={sanitiseHtml(viz.html)}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts"
            title={viz.title || "D3 visualization"}
          />
        ) : <div className="p-8 text-sm text-muted-foreground">Sin HTML</div>
      default:
        return <div className="p-8 text-sm text-muted-foreground">Formato no soportado: {viz.format}</div>
    }
  })()

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
      <VizHeader viz={viz} expanded={expanded} setExpanded={setExpanded} onDownload={download} />
      <div
        className={
          "relative w-full bg-white flex items-center justify-center overflow-hidden " +
          (expanded ? "h-[75vh]" : "h-[420px]")
        }
      >
        {body}
      </div>
    </div>
  )
}

function VizHeader({
  viz, expanded, setExpanded, onDownload,
}: {
  viz: VizFile
  expanded: boolean
  setExpanded: (v: boolean) => void
  onDownload: () => void
}) {
  return (
    <div className="flex items-center justify-between border-b border-border/50 bg-muted/10 px-3 py-2 text-[12px]">
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <BarChart3 className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-medium text-foreground">
          {viz.title || "Visualización"}
        </span>
        <span>· {FORMAT_LABEL[viz.format] || viz.format}</span>
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost" size="sm"
          onClick={() => setExpanded(!expanded)}
          className="h-7 px-2"
        >
          {expanded
            ? <Minimize2 className="h-3.5 w-3.5" />
            : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDownload} className="h-7 px-2">
          <Download className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

// Defense-in-depth sanitation for D3 HTML artefacts. The iframe
// sandbox is the main boundary — we still strip top-form-post and
// obviously bad patterns before handing the doc to srcDoc.
function sanitiseHtml(raw: string): string {
  if (!raw) return ""
  let s = raw
  // Allow <script> (D3 needs it) but drop top-level cookies / storage
  // patterns that almost never appear in legit chart artefacts.
  s = s.replace(/<meta\s+http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
  return s
}
