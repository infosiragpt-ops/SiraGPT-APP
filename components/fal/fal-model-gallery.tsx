"use client"

import * as React from "react"
import { Search, Sparkles, Check } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { FalBrandBadge } from "./fal-brand-badge"

export type FalModel = {
  id: string
  endpoint: string
  displayName: string
  brand: string
  iconKey: string
  group: string
  mode: string
  qualityTier: string
  tierRank: number
  capabilities: string[]
  description?: string
  provider: string
}

const GROUP_TABS: { key: string; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "image", label: "Imagen" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "3d", label: "3D" },
]

const TIER_CLASS: Record<string, string> = {
  Ultra: "fal-tier-ultra",
  Pro: "fal-tier-pro",
  Standard: "fal-tier-standard",
  Fast: "fal-tier-fast",
  Basic: "fal-tier-basic",
}

const PAGE = 48

function FalModelCard({
  model,
  active,
  onSelect,
}: {
  model: FalModel
  active: boolean
  onSelect: (m: FalModel) => void
}) {
  const onMove = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`)
    e.currentTarget.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`)
  }, [])

  return (
    <button
      type="button"
      onClick={() => onSelect(model)}
      onMouseMove={onMove}
      className={cn("fal-liquid-card group", active && "fal-liquid-card--active")}
      title={model.endpoint}
      data-tier={model.qualityTier}
    >
      <span className="fal-liquid-card__sheen" aria-hidden="true" />
      <span className="relative flex items-start gap-3">
        <FalBrandBadge iconKey={model.iconKey} size={44} />
        <span className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold leading-tight text-zinc-900 dark:text-white">
              {model.displayName}
            </span>
            {active && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {model.brand}
          </span>
        </span>
        <span className={cn("fal-tier-pill", TIER_CLASS[model.qualityTier] || "fal-tier-standard")}>
          {model.qualityTier}
        </span>
      </span>
      <span className="relative mt-2.5 flex flex-wrap items-center gap-1">
        <span className="fal-mode-chip">{model.mode}</span>
        {(model.capabilities || []).slice(0, 3).map((c) => (
          <span key={c} className="fal-cap-chip">
            {c}
          </span>
        ))}
      </span>
      <span className="relative mt-2 block truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
        {model.endpoint}
      </span>
    </button>
  )
}

export function FalModelGallery({
  open,
  onOpenChange,
  initialGroup = "all",
  activeEndpoint,
  onSelect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initialGroup?: string
  activeEndpoint?: string | null
  onSelect: (m: FalModel) => void
}) {
  const [models, setModels] = React.useState<FalModel[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [group, setGroup] = React.useState(initialGroup)
  const [query, setQuery] = React.useState("")
  const [limit, setLimit] = React.useState(PAGE)
  const loadedRef = React.useRef(false)

  React.useEffect(() => {
    if (open) setGroup(initialGroup)
  }, [open, initialGroup])

  React.useEffect(() => {
    if (!open || loadedRef.current) return
    loadedRef.current = true
    setLoading(true)
    fetch("/api/ai/fal-models")
      .then((r) => r.json())
      .then((j) => {
        if (j && Array.isArray(j.models)) setModels(j.models)
        else setError("No se pudo cargar el catálogo")
      })
      .catch(() => setError("No se pudo cargar el catálogo"))
      .finally(() => setLoading(false))
  }, [open])

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: models.length }
    for (const m of models) c[m.group] = (c[m.group] || 0) + 1
    return c
  }, [models])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter((m) => {
      if (group !== "all" && m.group !== group) return false
      if (q && !`${m.displayName} ${m.brand} ${m.id}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [models, group, query])

  React.useEffect(() => {
    setLimit(PAGE)
  }, [group, query])

  const visible = filtered.slice(0, limit)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="liquid-menu-surface fal-gallery max-w-[min(96vw,1040px)] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-3 border-b border-white/10 px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4.5 w-4.5 text-indigo-400" />
            Modelos fal.ai
            <span className="ml-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
              {models.length} modelos · mayor → menor calidad
            </span>
          </DialogTitle>
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <div className="flex flex-wrap gap-1.5">
              {GROUP_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setGroup(t.key)}
                  className={cn("fal-tab", group === t.key && "fal-tab--active")}
                >
                  {t.label}
                  {counts[t.key] != null && (
                    <span className="ml-1 opacity-60">{counts[t.key]}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="relative sm:ml-auto sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar modelo o marca…"
                className="h-9 rounded-full border-white/15 bg-white/5 pl-8 text-sm"
              />
            </div>
          </div>
        </DialogHeader>

        <div className="max-h-[64vh] overflow-y-auto px-5 py-4">
          {loading && <p className="py-10 text-center text-sm text-zinc-400">Cargando catálogo…</p>}
          {error && <p className="py-10 text-center text-sm text-rose-400">{error}</p>}
          {!loading && !error && (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((m) => (
                  <FalModelCard
                    key={m.id}
                    model={m}
                    active={activeEndpoint === m.id}
                    onSelect={(model) => {
                      onSelect(model)
                      onOpenChange(false)
                    }}
                  />
                ))}
              </div>
              {visible.length < filtered.length && (
                <div className="mt-4 flex justify-center">
                  <button type="button" className="fal-tab" onClick={() => setLimit((n) => n + PAGE)}>
                    Cargar más ({filtered.length - visible.length} restantes)
                  </button>
                </div>
              )}
              {filtered.length === 0 && (
                <p className="py-10 text-center text-sm text-zinc-400">Sin resultados.</p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default FalModelGallery
