"use client"

/**
 * Planos (/plan) — natural-language → DXF architectural floor plan.
 *
 * Left: composer with a textarea brief + generate button.
 * Right: DXF viewer (three.js under the hood) with pan/zoom/download.
 *
 * The chat metaphor (as in /design) didn't fit here — a plan is a
 * single artifact you tune until it's right, not a conversation. So
 * we keep a simple "regenerate / refine" loop with the latest brief.
 */

import * as React from "react"
import dynamic from "next/dynamic"
import { toast } from "sonner"
import { Download, Sparkles, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { planService } from "@/lib/plan-service"
import { normalizeChatInput, shouldWarnUser } from "@/lib/chat-input-normalize"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
const PlanViewer = dynamic(
  () => import("@/components/plan/plan-viewer").then(m => m.PlanViewer),
  { ssr: false, loading: () => <div className="h-full w-full" /> },
)

const SUGGESTIONS = [
  "Casa de 3 dormitorios, 2 baños, sala-comedor-cocina integrados, 110 m², terreno 12x10 m, terraza al norte.",
  "Departamento compacto 60 m², 2 dormitorios, 1 baño, cocina americana, lavandería.",
  "Casa de 1 planta, 4 dormitorios, 2 baños, estudio, patio interno, 160 m².",
]

export default function PlanPage() {
  const [brief, setBrief] = React.useState("")
  const [dxf, setDxf] = React.useState<string | null>(null)
  const [plan, setPlan] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(false)
  const abortRef = React.useRef<AbortController | null>(null)

  async function handleGenerate() {
    const normalized = normalizeChatInput(brief)
    if (shouldWarnUser(normalized)) {
      toast.error(
        `El brief supera el límite (${normalized.originalLength.toLocaleString()} caracteres). Se recortó.`,
        { duration: 4500 },
      )
    }
    const cleanBrief = normalized.value.trim()
    if (!cleanBrief || loading) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    try {
      const res = await planService.generate(cleanBrief, { signal: ctrl.signal })
      setDxf(res.dxf)
      setPlan(res.plan)
    } catch (err: any) {
      if (err?.name !== "AbortError") toast.error(err?.message || "Error generando plano")
    } finally {
      abortRef.current = null
      setLoading(false)
    }
  }

  function handleDownload() {
    if (!dxf) return
    const blob = new Blob([dxf], { type: "application/dxf" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${plan?.title || "plano"}.dxf`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-[calc(100vh-0px)] w-full">
      {/* Composer */}
      <aside className="flex w-full max-w-[380px] shrink-0 flex-col border-r border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3 w-3" />
            Planos arquitectónicos · DXF
          </div>
          <h1 className="mt-0.5 text-base font-semibold tracking-tight">
            Generador de planos
          </h1>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-foreground/80">Descripción</label>
            <Textarea
              value={brief}
              onChange={e => setBrief(e.target.value)}
              placeholder="Casa de 3 dormitorios, 2 baños, sala-comedor-cocina, 110 m²…"
              rows={6}
              className="mt-1.5 resize-none text-[13px]"
            />
          </div>

          {!dxf && (
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Ejemplos
              </div>
              <ul className="mt-2 space-y-1.5">
                {SUGGESTIONS.map((s, i) => (
                  <li key={i}>
                    <button
                      onClick={() => setBrief(s)}
                      className="w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] leading-snug text-foreground/75 hover:border-border hover:bg-background"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan && (
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-[12px]">
              <div className="font-semibold text-foreground">{plan.title}</div>
              <div className="mt-1 text-muted-foreground">
                {plan.rooms?.length ?? 0} ambientes · escala {plan.scale || "1:100"}
              </div>
              {plan.rooms && (
                <ul className="mt-2 space-y-0.5 text-muted-foreground">
                  {plan.rooms.slice(0, 8).map((r: any, i: number) => (
                    <li key={i} className="flex justify-between">
                      <span>{r.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border/60 p-3 space-y-2">
          <Button
            onClick={handleGenerate}
            disabled={!brief.trim() || loading}
            className="w-full"
          >
            {loading ? (
              <><ThinkingIndicator size="sm" className="mr-2 h-3.5 w-3.5" />Generando…</>
            ) : dxf ? (
              <><RefreshCw className="mr-2 h-3.5 w-3.5" />Regenerar</>
            ) : (
              <><Sparkles className="mr-2 h-3.5 w-3.5" />Generar plano</>
            )}
          </Button>
          {dxf && (
            <Button variant="outline" onClick={handleDownload} className="w-full">
              <Download className="mr-2 h-3.5 w-3.5" />Descargar .dxf
            </Button>
          )}
        </div>
      </aside>

      {/* Viewer */}
      <main className="relative flex-1 bg-muted/5">
        <PlanViewer dxf={dxf} />
      </main>
    </div>
  )
}
