"use client"

/**
 * PlanArtifactDisplay — inline chat renderer for architectural floor
 * plans.
 *
 * The server emits a `plan`-typed file with both an SVG (inline
 * rendering, the primary surface) and a DXF (pro download). SVG gets
 * embedded into the DOM via `dangerouslySetInnerHTML` after a light
 * safety pass that rejects anything other than pure `<svg>` markup
 * (no `<script>`, no `<foreignObject>`, no `<iframe>`). The markup we
 * produce on the server is fully known — this is defense-in-depth.
 *
 * Minimal chrome: rounded card, thin border, inline SVG that scales
 * to width, small action row for download + expand. Matches the
 * Claude-style artifact aesthetic the user asked for.
 */

import * as React from "react"
import { Download, Maximize2, Minimize2, Ruler } from "lucide-react"

import { Button } from "@/components/ui/button"

interface PlanFile {
  type: "plan"
  svg?: string
  dxf?: string | null
  plan?: any
  title?: string
}

interface Props {
  files: any[]
}

function sanitiseSvg(raw: string): string {
  if (!raw) return ""
  // Reject anything that isn't a well-formed <svg>…</svg>. We strip
  // <script>, <foreignObject>, <iframe>, on* attributes, and
  // javascript: URLs. The server produces safe markup but this keeps
  // us honest if the LLM ever writes SVG directly.
  const trimmed = raw.trim()
  const m = trimmed.match(/<svg[\s\S]*?<\/svg>/i)
  if (!m) return ""
  let svg = m[0]
  svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "")
  svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
  svg = svg.replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
  svg = svg.replace(/\son\w+\s*=\s*(['"])[\s\S]*?\1/gi, "")
  svg = svg.replace(/\shref\s*=\s*(['"])\s*javascript:[\s\S]*?\1/gi, "")
  return svg
}

export function PlanArtifactDisplay({ files }: Props) {
  const plans = React.useMemo<PlanFile[]>(
    () => (Array.isArray(files) ? files.filter((f: any) => f?.type === "plan") : []),
    [files]
  )
  if (plans.length === 0) return null
  return (
    <div className="mt-3 space-y-3">
      {plans.map((p, i) => <PlanCard key={i} plan={p} />)}
    </div>
  )
}

function PlanCard({ plan }: { plan: PlanFile }) {
  const [expanded, setExpanded] = React.useState(false)
  const title = plan.title || plan.plan?.title || plan.plan?.project?.name || "Plano arquitectónico"
  const rooms = plan.plan?.rooms?.length || 0
  const scale = plan.plan?.scale || "1:100"
  const safeSvg = React.useMemo(() => sanitiseSvg(plan.svg || ""), [plan.svg])

  function downloadDxf() {
    if (!plan.dxf) return
    const blob = new Blob([plan.dxf], { type: "application/dxf" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${title.replace(/[^\w\s-]/g, "").trim() || "plano"}.dxf`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  function downloadSvg() {
    if (!plan.svg) return
    const blob = new Blob([plan.svg], { type: "image/svg+xml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${title.replace(/[^\w\s-]/g, "").trim() || "plano"}.svg`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-background">
      {/* Plan area — the SVG scales to width, preserves aspect. */}
      <div
        className={
          "relative w-full bg-[#fafaf7] flex items-center justify-center " +
          (expanded ? "min-h-[75vh]" : "")
        }
      >
        {safeSvg ? (
          <div
            className="plan-svg-wrap w-full [&>svg]:block [&>svg]:w-full [&>svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: safeSvg }}
          />
        ) : (
          <div className="py-16 text-sm text-muted-foreground">
            Sin vista previa disponible
          </div>
        )}
      </div>

      {/* Action bar — minimal, thin top border, flat chrome. */}
      <div className="flex items-center justify-between border-t border-border/50 bg-background px-3 py-2 text-[12px]">
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Ruler className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{title}</span>
          <span>· {rooms} ambientes · {scale}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost" size="sm"
            onClick={() => setExpanded(v => !v)}
            className="h-7 px-2"
          >
            {expanded
              ? <Minimize2 className="h-3.5 w-3.5" />
              : <Maximize2 className="h-3.5 w-3.5" />}
          </Button>
          {safeSvg && (
            <Button variant="ghost" size="sm" onClick={downloadSvg} className="h-7 px-2">
              <Download className="h-3.5 w-3.5" />
              <span className="ml-1 hidden text-[11.5px] sm:inline">SVG</span>
            </Button>
          )}
          {plan.dxf && (
            <Button variant="ghost" size="sm" onClick={downloadDxf} className="h-7 px-2">
              <Download className="h-3.5 w-3.5" />
              <span className="ml-1 hidden text-[11.5px] sm:inline">DXF</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
