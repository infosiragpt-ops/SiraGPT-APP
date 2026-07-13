"use client"

import { BookOpen, Sparkles } from "lucide-react"
import { toast } from "sonner"

import apiClient from "@/lib/api"
import type { ResearchResultSource } from "@/lib/research-results"
import ResearchResultsWorkbench from "@/components/research/ResearchResultsWorkbench"

export type ScientificPaper = ResearchResultSource

export type PapersPayload = {
  query?: string
  count?: number
  providers?: string[]
  papers?: ScientificPaper[]
}

export function PapersResultCard({ data }: { data: PapersPayload }) {
  const papers = Array.isArray(data?.papers) ? data.papers : []
  const providers = Array.isArray(data?.providers) ? data.providers : []
  const total = typeof data?.count === "number" ? data.count : papers.length

  if (!papers.length) {
    return (
      <div className="my-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground"><BookOpen className="h-4 w-4" />Sin resultados</div>
        <p className="mt-1">No encontré artículos para {data?.query ? <span className="font-medium">“{data.query}”</span> : "esa búsqueda"}. Prueba términos más específicos.</p>
      </div>
    )
  }

  return (
    <div className="my-2 w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-background font-sans whitespace-normal">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold"><BookOpen className="h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{total.toLocaleString()} artículos científicos</span></div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{data?.query || "Investigación científica"} · {providers.length || "varias"} fuentes</p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground"><Sparkles className="h-3 w-3" />Resultados verificables</span>
      </div>
      <ResearchResultsWorkbench
        query={data?.query || ""}
        sources={papers}
        onSave={async (selection) => {
          try {
            await apiClient.saveResearchReferences({ sources: selection, collectionName: "Fuentes guardadas", tags: ["chat", "investigación"] })
            toast.success(`${selection.length} referencias guardadas en Biblioteca`)
          } catch (error: any) {
            toast.error(error?.message || "No se pudieron guardar las referencias")
            throw error
          }
        }}
      />
    </div>
  )
}

export default PapersResultCard
