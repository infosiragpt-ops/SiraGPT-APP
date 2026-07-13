"use client"

import * as React from "react"
import {
  ArrowDownUp,
  Bell,
  BellOff,
  BookMarked,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  GitCompareArrows,
  Play,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import apiClient, { type ResearchSavedSearchRecord } from "@/lib/api"
import {
  DEFAULT_RESEARCH_FILTERS,
  applyResearchResultFilters,
  dispatchResearchFollowUp,
  researchCitationCount,
  researchKeyFinding,
  researchSampleSize,
  researchSourceIdentity,
  sortResearchResults,
  type ResearchResultFilters,
  type ResearchResultSource,
  type ResearchSortMode,
} from "@/lib/research-results"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Props = {
  query: string
  sources: ResearchResultSource[]
  compact?: boolean
  onSave?: (sources: ResearchResultSource[]) => Promise<void>
}

const SORT_OPTIONS: Array<{ value: ResearchSortMode; label: string }> = [
  { value: "relevance", label: "Pertinencia" },
  { value: "date", label: "Más recientes" },
  { value: "citations", label: "Más citados" },
  { value: "evidence", label: "Nivel de evidencia" },
  { value: "access", label: "Acceso disponible" },
]

function authorLine(source: ResearchResultSource) {
  const authors = (Array.isArray(source.authors) ? source.authors : [])
    .map((author) => typeof author === "string" ? author : author?.name || "")
    .filter(Boolean)
  if (authors.length <= 3) return authors.join(", ")
  return `${authors.slice(0, 3).join(", ")} et al.`
}

function sourceUrl(source: ResearchResultSource) {
  if (source.url || source.htmlUrl) return source.url || source.htmlUrl || null
  if (source.doi) return `https://doi.org/${String(source.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}`
  return source.pdfUrl || null
}

function sourceProviders(source: ResearchResultSource) {
  return Array.from(new Set([
    source.source,
    ...(Array.isArray(source.sources) ? source.sources : []),
  ].map((provider) => String(provider || "").trim().toLowerCase()).filter(Boolean)))
}

function filterPayload(filters: ResearchResultFilters, sort: ResearchSortMode) {
  return {
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    openAccess: filters.openAccess === "all" ? null : filters.openAccess === "yes",
    peerReviewed: filters.peerReviewed === "all" ? null : filters.peerReviewed === "yes",
    studyTypes: filters.studyType === "all" ? [] : [filters.studyType],
    providers: filters.provider === "all" ? [] : [filters.provider],
    sort,
    limit: 50,
  }
}

function formatRun(value?: string | null) {
  if (!value) return "Aún no ejecutada"
  return new Intl.DateTimeFormat("es-PE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
}

export default function ResearchResultsWorkbench({ query, sources, compact = false, onSave }: Props) {
  const [liveSources, setLiveSources] = React.useState<ResearchResultSource[]>(sources)
  const [filters, setFilters] = React.useState<ResearchResultFilters>(DEFAULT_RESEARCH_FILTERS)
  const [sort, setSort] = React.useState<ResearchSortMode>("relevance")
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [showAll, setShowAll] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [compareOpen, setCompareOpen] = React.useState(false)
  const [savedOpen, setSavedOpen] = React.useState(false)
  const [savedSearches, setSavedSearches] = React.useState<ResearchSavedSearchRecord[]>([])
  const [savedName, setSavedName] = React.useState("")
  const [schedule, setSchedule] = React.useState<"manual" | "daily" | "weekly">("manual")
  const [notifyInApp, setNotifyInApp] = React.useState(true)
  const [savedBusy, setSavedBusy] = React.useState<string | null>(null)

  React.useEffect(() => {
    setLiveSources(sources)
    setSelected(new Set())
    setExpanded(new Set())
  }, [sources])

  const providers = React.useMemo(() => Array.from(new Set(liveSources.flatMap(sourceProviders))).sort(), [liveSources])
  const studyTypes = React.useMemo(() => Array.from(new Set(liveSources.map((source) => String(source.studyType || "").toLowerCase()).filter(Boolean))).sort(), [liveSources])
  const filtered = React.useMemo(() => sortResearchResults(applyResearchResultFilters(liveSources, filters), sort), [filters, liveSources, sort])
  const visible = showAll ? filtered : filtered.slice(0, compact ? 8 : 12)
  const selectedSources = React.useMemo(() => liveSources.filter((source, index) => selected.has(researchSourceIdentity(source, index))), [liveSources, selected])
  const activeFilterCount = [filters.yearFrom, filters.yearTo, filters.openAccess !== "all", filters.peerReviewed !== "all", filters.studyType !== "all", filters.provider !== "all"].filter(Boolean).length

  const loadSaved = React.useCallback(async () => {
    try {
      const response = await apiClient.getResearchSavedSearches()
      setSavedSearches(response.items || [])
    } catch (error: any) {
      toast.error(error?.message || "No se pudieron cargar las búsquedas guardadas")
    }
  }, [])

  React.useEffect(() => {
    if (savedOpen) void loadSaved()
  }, [loadSaved, savedOpen])

  const toggleSelected = (source: ResearchResultSource, index: number) => {
    const identity = researchSourceIdentity(source, index)
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(identity)) next.delete(identity)
      else if (next.size < 4) next.add(identity)
      else toast.error("Puedes comparar hasta cuatro estudios")
      return next
    })
  }

  const saveVisible = async () => {
    if (!onSave) return
    const selection = selectedSources.length ? selectedSources : filtered
    if (!selection.length) return
    setSaving(true)
    try {
      await onSave(selection)
    } finally {
      setSaving(false)
    }
  }

  const createSavedSearch = async () => {
    if (!savedName.trim() || !query.trim()) return
    setSavedBusy("create")
    try {
      await apiClient.createResearchSavedSearch({
        name: savedName.trim(),
        query,
        filters: filterPayload(filters, sort),
        schedule,
        active: true,
        notifyInApp,
      })
      setSavedName("")
      toast.success(schedule === "manual" ? "Búsqueda guardada" : "Alerta científica activada")
      await loadSaved()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo guardar la búsqueda")
    } finally {
      setSavedBusy(null)
    }
  }

  const runSavedSearch = async (item: ResearchSavedSearchRecord) => {
    setSavedBusy(item.id)
    try {
      const result = await apiClient.runResearchSavedSearch(item.id) as any
      const next = Array.isArray(result?.papers) ? result.papers : []
      setLiveSources(next)
      setSelected(new Set())
      toast.success(`${next.length} resultados · ${result?.newPapers?.length || 0} nuevos`)
      setSavedOpen(false)
      await loadSaved()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo ejecutar la búsqueda")
    } finally {
      setSavedBusy(null)
    }
  }

  const updateSavedSearch = async (item: ResearchSavedSearchRecord) => {
    setSavedBusy(item.id)
    try {
      await apiClient.updateResearchSavedSearch(item.id, { active: !item.active })
      await loadSaved()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo actualizar la alerta")
    } finally {
      setSavedBusy(null)
    }
  }

  const deleteSavedSearch = async (item: ResearchSavedSearchRecord) => {
    setSavedBusy(item.id)
    try {
      await apiClient.deleteResearchSavedSearch(item.id)
      await loadSaved()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo eliminar la búsqueda")
    } finally {
      setSavedBusy(null)
    }
  }

  return (
    <section className="w-full min-w-0 max-w-full overflow-hidden whitespace-normal font-sans" aria-label="Resultados de investigación">
      <div className={cn("flex min-w-0 flex-wrap items-center gap-2 border-b border-border/50", compact ? "px-3 py-3 sm:px-4" : "px-3 py-3 sm:px-4 sm:py-3.5") }>
        <Button type="button" variant={filtersOpen ? "secondary" : "outline"} size="sm" onClick={() => setFiltersOpen((value) => !value)} aria-expanded={filtersOpen}>
          <SlidersHorizontal className="mr-2 h-4 w-4" />Filtros{activeFilterCount ? ` (${activeFilterCount})` : ""}
        </Button>
        <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
          <ArrowDownUp className="h-3.5 w-3.5" />
          <span className="sr-only">Ordenar resultados</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as ResearchSortMode)} className="min-w-0 bg-transparent text-foreground outline-none" aria-label="Ordenar resultados">
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" size="sm" disabled={selectedSources.length < 2} onClick={() => setCompareOpen(true)}>
          <GitCompareArrows className="mr-2 h-4 w-4" />Comparar{selectedSources.length ? ` (${selectedSources.length})` : ""}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!selectedSources.length} onClick={() => {
          dispatchResearchFollowUp(query, selectedSources)
          toast.success("Fuentes añadidas a la pregunta de seguimiento")
        }}>
          <Send className="mr-2 h-4 w-4" />Preguntar
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setSavedOpen(true)}>
          <Bell className="mr-2 h-4 w-4" />Búsquedas
        </Button>
        {onSave ? (
          <Button type="button" variant="outline" size="sm" disabled={!filtered.length || saving} onClick={saveVisible}>
            <BookMarked className="mr-2 h-4 w-4" />{saving ? "Guardando…" : selectedSources.length ? `Guardar ${selectedSources.length}` : "Guardar resultados"}
          </Button>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="grid grid-cols-2 gap-3 border-b border-border/50 bg-muted/20 px-4 py-4 md:grid-cols-3 xl:grid-cols-6" aria-label="Filtros científicos">
          <label className="space-y-1 text-xs font-medium">Desde
            <Input type="number" inputMode="numeric" min={1800} max={2100} value={filters.yearFrom ?? ""} onChange={(event) => setFilters((current) => ({ ...current, yearFrom: event.target.value ? Number(event.target.value) : null }))} className="h-9" />
          </label>
          <label className="space-y-1 text-xs font-medium">Hasta
            <Input type="number" inputMode="numeric" min={1800} max={2100} value={filters.yearTo ?? ""} onChange={(event) => setFilters((current) => ({ ...current, yearTo: event.target.value ? Number(event.target.value) : null }))} className="h-9" />
          </label>
          <label className="space-y-1 text-xs font-medium">Acceso
            <select aria-label="Filtrar por acceso" value={filters.openAccess} onChange={(event) => setFilters((current) => ({ ...current, openAccess: event.target.value as ResearchResultFilters["openAccess"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="all">Cualquiera</option><option value="yes">Abierto</option><option value="no">Restringido</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">Revisión
            <select aria-label="Filtrar por revisión por pares" value={filters.peerReviewed} onChange={(event) => setFilters((current) => ({ ...current, peerReviewed: event.target.value as ResearchResultFilters["peerReviewed"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="all">Cualquiera</option><option value="yes">Revisado</option><option value="no">No confirmado</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">Diseño
            <select aria-label="Filtrar por diseño de estudio" value={filters.studyType} onChange={(event) => setFilters((current) => ({ ...current, studyType: event.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="all">Todos</option>{studyTypes.map((study) => <option key={study} value={study}>{study.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">Fuente
            <select aria-label="Filtrar por proveedor" value={filters.provider} onChange={(event) => setFilters((current) => ({ ...current, provider: event.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="all">Todas</option>{providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
            </select>
          </label>
          <div className="col-span-2 flex items-end md:col-span-3 xl:col-span-6">
            <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_RESEARCH_FILTERS)}>Restablecer filtros</Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
        <span>{filtered.length} de {liveSources.length} estudios</span>
        <span>{selectedSources.length} seleccionados</span>
      </div>

      {visible.length ? (
        <ol className="min-w-0 list-none space-y-2 px-2 pb-3 sm:px-3">
          {visible.map((source, index) => {
            const identity = researchSourceIdentity(source, index)
            const isExpanded = expanded.has(identity)
            const isSelected = selected.has(identity)
            const href = sourceUrl(source)
            const authors = authorLine(source)
            const meta = [authors, source.year || null, source.journal || source.venue || null].filter(Boolean).join(" · ")
            return (
              <li key={identity}>
                <article className={cn("w-full min-w-0 max-w-full overflow-hidden rounded-lg border bg-background p-3 transition-colors", isSelected ? "border-foreground/40" : "border-border/60")}>
                  <div className="flex min-w-0 items-start gap-3">
                    <label className="mt-0.5 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border" title="Seleccionar para comparar">
                      <input type="checkbox" className="sr-only" checked={isSelected} onChange={() => toggleSelected(source, index)} aria-label={`Seleccionar ${source.title || "estudio"} para comparar`} />
                      {isSelected ? <Check className="h-4 w-4" /> : <span className="text-[11px] text-muted-foreground">{index + 1}</span>}
                    </label>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <h3 className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 [overflow-wrap:anywhere]">{source.title || "Fuente sin título"}</h3>
                        <span className="shrink-0 text-xs font-medium text-muted-foreground">{researchCitationCount(source).toLocaleString()} citas</span>
                      </div>
                      {meta ? <p className="mt-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{meta}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                        {source.studyType ? <span className="rounded bg-muted px-1.5 py-0.5">{source.studyType.replace(/_/g, " ")}</span> : null}
                        {source.peerReviewStatus ? <span className="rounded bg-muted px-1.5 py-0.5">{source.peerReviewStatus.replace(/_/g, " ")}</span> : null}
                        {source.openAccess ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">Acceso abierto</span> : null}
                        {source.integrityStatus && source.integrityStatus !== "clear" && source.integrityStatus !== "unknown" ? <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">{source.integrityStatus.replace(/_/g, " ")}</span> : null}
                      </div>
                      {isExpanded ? (
                        <div className="mt-3 space-y-3 border-t border-border/50 pt-3 text-xs leading-5 text-muted-foreground">
                          <p>{source.abstract || "Esta fuente no incluye resumen en sus metadatos."}</p>
                          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                            <div><dt className="font-medium text-foreground">DOI</dt><dd className="break-all">{source.doi || "No disponible"}</dd></div>
                            <div><dt className="font-medium text-foreground">Integridad</dt><dd>{source.integrityStatus || "sin alertas"}</dd></div>
                            <div><dt className="font-medium text-foreground">Resolución DOI</dt><dd>{source.doiResolutionStatus || source.doiStatus || "no comprobada"}</dd></div>
                            <div><dt className="font-medium text-foreground">Proveedores</dt><dd>{sourceProviders(source).join(", ") || "sin identificar"}</dd></div>
                          </dl>
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setExpanded((current) => {
                          const next = new Set(current)
                          if (next.has(identity)) next.delete(identity); else next.add(identity)
                          return next
                        })} aria-expanded={isExpanded}>
                          {isExpanded ? <ChevronUp className="mr-1.5 h-3.5 w-3.5" /> : <ChevronDown className="mr-1.5 h-3.5 w-3.5" />}{isExpanded ? "Ocultar" : "Ver resumen"}
                        </Button>
                        {source.pdfUrl ? <a href={source.pdfUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-muted"><FileText className="h-3.5 w-3.5" />PDF</a> : null}
                        {href ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium hover:bg-muted"><ExternalLink className="h-3.5 w-3.5" />Fuente</a> : null}
                        {source.integrityStatus === "clear" ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" />Sin alertas</span> : null}
                      </div>
                    </div>
                  </div>
                </article>
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">No hay estudios que cumplan estos filtros.</div>
      )}

      {filtered.length > (compact ? 8 : 12) ? (
        <div className="border-t border-border/50 px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>{showAll ? "Ver menos" : `Ver los ${filtered.length} resultados`}</Button>
        </div>
      ) : null}

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle>Comparar estudios</DialogTitle><DialogDescription>{selectedSources.length} estudios seleccionados.</DialogDescription></DialogHeader>
          <div className="max-h-[65vh] overflow-auto">
            <table className="w-full min-w-[980px] border-collapse text-left text-xs">
              <thead><tr className="border-b"><th className="p-2">Estudio</th><th className="p-2">Diseño</th><th className="p-2">Muestra</th><th className="p-2">Hallazgo</th><th className="p-2">Año</th><th className="p-2">Citas</th><th className="p-2">Acceso</th><th className="p-2">Integridad</th></tr></thead>
              <tbody>{selectedSources.map((source, index) => <tr key={researchSourceIdentity(source, index)} className="border-b align-top"><td className="max-w-xs p-2 font-medium">{source.title || "Sin título"}</td><td className="p-2">{source.studyType || "No identificado"}</td><td className="p-2">{researchSampleSize(source) || "No disponible"}</td><td className="max-w-sm p-2 leading-5">{researchKeyFinding(source) || "No disponible en metadatos"}</td><td className="p-2">{source.year || "—"}</td><td className="p-2">{researchCitationCount(source)}</td><td className="p-2">{source.openAccess ? "Abierto" : source.pdfUrl ? "PDF" : "Restringido"}</td><td className="p-2">{source.integrityStatus || "Sin alertas"}</td></tr>)}</tbody>
            </table>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setCompareOpen(false)}>Cerrar</Button><Button type="button" onClick={() => { dispatchResearchFollowUp(query, selectedSources); setCompareOpen(false); toast.success("Comparación añadida al chat") }}><Send className="mr-2 h-4 w-4" />Preguntar sobre la comparación</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={savedOpen} onOpenChange={setSavedOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Búsquedas guardadas y alertas</DialogTitle><DialogDescription>Consulta, frecuencia y estado de cada búsqueda.</DialogDescription></DialogHeader>
          <div className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[1fr_150px_auto]">
            <Input value={savedName} onChange={(event) => setSavedName(event.target.value)} placeholder="Nombre de la búsqueda" aria-label="Nombre de la búsqueda" />
            <select value={schedule} onChange={(event) => setSchedule(event.target.value as typeof schedule)} className="h-10 rounded-md border border-input bg-background px-3 text-sm" aria-label="Frecuencia de la alerta"><option value="manual">Manual</option><option value="daily">Diaria</option><option value="weekly">Semanal</option></select>
            <Button type="button" disabled={!savedName.trim() || savedBusy === "create"} onClick={createSavedSearch}><Save className="mr-2 h-4 w-4" />Guardar</Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-3"><input type="checkbox" checked={notifyInApp} onChange={(event) => setNotifyInApp(event.target.checked)} />Notificarme dentro de SiraGPT cuando haya artículos nuevos</label>
          </div>
          <div className="max-h-[45vh] space-y-2 overflow-auto">
            {savedSearches.length ? savedSearches.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{item.name}</div><div className="mt-0.5 truncate text-xs text-muted-foreground">{item.query}</div><div className="mt-1 text-[11px] text-muted-foreground">{item.schedule === "manual" ? "Manual" : item.schedule === "daily" ? "Diaria" : "Semanal"} · {item.lastResultCount} resultados · {item.lastNewCount} nuevos · {formatRun(item.lastRunAt)}</div></div>
                <Button type="button" variant="outline" size="icon" disabled={savedBusy === item.id} onClick={() => runSavedSearch(item)} aria-label={`Ejecutar ${item.name}`} title="Ejecutar ahora"><Play className="h-4 w-4" /></Button>
                {item.schedule !== "manual" ? <Button type="button" variant="outline" size="icon" disabled={savedBusy === item.id} onClick={() => updateSavedSearch(item)} aria-label={item.active ? `Pausar ${item.name}` : `Activar ${item.name}`} title={item.active ? "Pausar alerta" : "Activar alerta"}>{item.active ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}</Button> : null}
                <Button type="button" variant="ghost" size="icon" disabled={savedBusy === item.id} onClick={() => deleteSavedSearch(item)} aria-label={`Eliminar ${item.name}`} title="Eliminar"><Trash2 className="h-4 w-4" /></Button>
              </div>
            )) : <div className="py-8 text-center text-sm text-muted-foreground">Aún no tienes búsquedas científicas guardadas.</div>}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
