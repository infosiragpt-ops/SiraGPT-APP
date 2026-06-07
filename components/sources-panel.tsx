"use client"

/**
 * SourcesPanel — the integrated right-side "Actividad / Fuentes" pane.
 *
 * Renders the same Actividad → Pensando → "Fuentes · N" content as the
 * SourcesChip portal drawer, but mounted in the chat's shared resizable
 * right-pane slot (the same slot the Word / Excel / Document / Activity
 * viewers use). That makes it push the conversation to the left instead of
 * floating over it. Opened from a message's "Fuentes" chip via the
 * onOpenSources handler threaded down from ChatInterfaceEnhanced.
 */

import * as React from "react"
import {
  Brain,
  Briefcase,
  Check,
  ExternalLink,
  Globe,
  Heart,
  Lightbulb,
  Search,
  Sparkles,
  ThumbsDown,
  Trash2,
  User,
  X,
} from "lucide-react"
import { apiClient } from "@/lib/api"
import {
  Favicon,
  domainOf,
  formatElapsed,
  safeHref,
  type ChipActivity,
  type ChipMemoryItem,
  type ChipMemoryMeta,
  type ChipSource,
} from "@/components/SourcesChip"

interface SourcesPanelProps {
  sources: ChipSource[]
  activity?: ChipActivity
  memory?: ChipMemoryItem[]
  memoryMeta?: ChipMemoryMeta
  onClose: () => void
}

const MEMORY_TIER_LABEL: Record<string, string> = {
  long_term: "Largo plazo",
  short_term: "Reciente",
}

const MEMORY_CATEGORY_LABEL: Record<string, string> = {
  identity: "Identidad",
  preference: "Preferencia",
  project: "Proyecto",
  instruction: "Instrucción",
  general: "Dato",
}

function memoryIcon(category?: string, polarity?: string) {
  if (polarity === "negative") return ThumbsDown
  switch (category) {
    case "identity":
      return User
    case "preference":
      return Heart
    case "project":
      return Briefcase
    case "instruction":
      return Lightbulb
    default:
      return Sparkles
  }
}

/** Compact relative-age label: "hoy", "ayer", "hace 3 d", "hace 2 sem". */
function formatAge(ageMs?: number | null): string {
  if (typeof ageMs !== "number" || ageMs < 0) return ""
  const days = Math.floor(ageMs / 86_400_000)
  if (days <= 0) return "hoy"
  if (days === 1) return "ayer"
  if (days < 14) return `hace ${days} d`
  if (days < 60) return `hace ${Math.floor(days / 7)} sem`
  return `hace ${Math.floor(days / 30)} mes`
}

export function SourcesPanel({ sources, activity, memory, memoryMeta, onClose }: SourcesPanelProps) {
  const safeSources = React.useMemo(
    () => (Array.isArray(sources) ? sources.filter(Boolean) : []),
    [sources],
  )
  const safeMemory = React.useMemo(
    () => (Array.isArray(memory) ? memory.filter((m) => m && m.fact) : []),
    [memory],
  )
  const domains = React.useMemo(() => safeSources.map(domainOf), [safeSources])
  const uniqueDomains = React.useMemo(
    () => Array.from(new Set(domains.filter(Boolean))),
    [domains],
  )
  const previewDomains = uniqueDomains.slice(0, 3)
  const elapsed = formatElapsed(activity?.elapsedMs)
  const query = activity?.query || ""
  // Optimistic "forget": ids the user removed this session are hidden
  // immediately while the DELETE round-trips.
  const [forgotten, setForgotten] = React.useState<Set<string>>(new Set())
  const [forgetting, setForgetting] = React.useState<Set<string>>(new Set())

  const visibleMemory = React.useMemo(
    () => safeMemory.filter((m) => !m.id || !forgotten.has(m.id)),
    [safeMemory, forgotten],
  )
  const hasSources = safeSources.length > 0
  const hasMemory = visibleMemory.length > 0
  const memoryReason = memoryMeta?.reason || ""

  const handleForget = React.useCallback(async (item: ChipMemoryItem) => {
    if (!item.id) return
    const id = item.id
    setForgetting((prev) => new Set(prev).add(id))
    const ok = await apiClient.forgetMemory(id)
    setForgetting((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    if (ok) {
      setForgotten((prev) => new Set(prev).add(id))
    }
  }, [])

  // Esc closes the panel, matching the other right-pane viewers.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-5 py-4 backdrop-blur">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold text-foreground">Actividad</h2>
          {elapsed ? <span className="text-sm text-muted-foreground">· {elapsed}</span> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Cerrar"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* MEMORIA — autonomously recalled memory the model used this turn */}
      {hasMemory ? (
        <div className="border-b border-border px-5 py-4">
          <div className="mb-1 flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400">
              <Brain className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
              MEMORIA
            </h3>
            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-400">
              {visibleMemory.length}
            </span>
            {typeof memoryMeta?.confidence === "number" ? (
              <span
                className="ml-auto text-[11px] font-medium text-muted-foreground"
                title="Confianza de la decisión de recordar"
              >
                {Math.round((memoryMeta.confidence || 0) * 100)}% confianza
              </span>
            ) : null}
          </div>
          {memoryReason ? (
            <p className="mb-3 mt-1 text-xs leading-5 text-muted-foreground">{memoryReason}</p>
          ) : (
            <div className="mb-3" />
          )}
          <ul className="space-y-1.5">
            {visibleMemory.map((m, i) => {
              const tierLabel = m.tier ? (MEMORY_TIER_LABEL[m.tier] || m.tier) : null
              const categoryLabel = m.category ? (MEMORY_CATEGORY_LABEL[m.category] || m.category) : null
              const ageLabel = formatAge(m.ageMs)
              const relevancePct = typeof m.relevance === "number" ? Math.round(Math.min(1, m.relevance) * 100) : null
              const semanticPct = typeof m.semantic === "number" ? Math.round(Math.min(1, Math.max(0, m.semantic)) * 100) : null
              const Icon = memoryIcon(m.category, m.polarity)
              const isForgetting = !!m.id && forgetting.has(m.id)
              return (
                <li
                  key={m.id || `mem-${i}`}
                  className="group relative flex items-start gap-2.5 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-2.5 transition-colors hover:border-violet-500/40"
                >
                  <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400">
                    <Icon className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="pr-5 text-sm leading-5 text-foreground">{m.fact}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {categoryLabel ? (
                        <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400">
                          {categoryLabel}
                        </span>
                      ) : null}
                      {tierLabel ? (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {tierLabel}
                        </span>
                      ) : null}
                      {relevancePct !== null ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
                          title="Relevancia para tu mensaje"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
                          {relevancePct}%
                        </span>
                      ) : null}
                      {semanticPct !== null ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400"
                          title="Similitud semántica (por significado)"
                        >
                          ~{semanticPct}% similitud
                        </span>
                      ) : null}
                      {ageLabel ? (
                        <span className="text-[10px] text-muted-foreground">· {ageLabel}</span>
                      ) : null}
                    </div>
                    {Array.isArray(m.matchedTopics) && m.matchedTopics.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">recordado por</span>
                        {m.matchedTopics.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {m.id ? (
                    <button
                      type="button"
                      onClick={() => handleForget(m)}
                      disabled={isForgetting}
                      title="Olvidar este dato"
                      aria-label="Olvidar este dato"
                      className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {/* Thinking / steps — only meaningful when web sources were searched */}
      {hasSources ? (
      <div className="px-5 py-4">
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Pensando</h3>
        <ol className="relative space-y-4 border-l border-border pl-5">
          <li className="relative">
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Search className="h-2.5 w-2.5" />
            </span>
            <p className="text-sm font-medium text-foreground">
              Buscando fuentes{query ? ` sobre "${query}"` : ""}
            </p>
            {previewDomains.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previewDomains.map((d) => (
                  <span
                    key={d}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                  >
                    <Favicon domain={d} size={14} />
                    <span className="max-w-[120px] truncate">{d}</span>
                  </span>
                ))}
                {uniqueDomains.length > previewDomains.length ? (
                  <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                    +{uniqueDomains.length - previewDomains.length} más
                  </span>
                ) : null}
              </div>
            ) : null}
          </li>
          <li className="relative">
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Globe className="h-2.5 w-2.5" />
            </span>
            <p className="text-sm text-foreground">
              Analizando {safeSources.length}{" "}
              {safeSources.length === 1 ? "fuente encontrada" : "fuentes encontradas"}
            </p>
          </li>
          <li className="relative">
            <span className="absolute -left-[27px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <Check className="h-2.5 w-2.5" />
            </span>
            <p className="text-sm text-muted-foreground">Listo</p>
          </li>
        </ol>
      </div>
      ) : null}

      {/* Sources list */}
      {hasSources ? (
      <div className="border-t border-border px-5 py-4">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Fuentes · {safeSources.length}</h3>
        <ul className="space-y-1">
          {safeSources.map((s, i) => {
            const d = domainOf(s)
            const href = safeHref(s.url)
            const inner = (
              <>
                <span className="mt-0.5 flex-shrink-0">
                  <Favicon domain={d} size={20} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{d || "fuente"}</span>
                    {href ? (
                      <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : null}
                  </span>
                  <span className="line-clamp-2 text-sm font-medium text-foreground">
                    {s.title || d || "Fuente"}
                  </span>
                  {s.snippet ? (
                    <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.snippet}</span>
                  ) : null}
                </span>
              </>
            )
            return (
              <li key={`${s.url}-${i}`}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex gap-3 rounded-lg p-2 transition-colors hover:bg-muted"
                  >
                    {inner}
                  </a>
                ) : (
                  <div className="group flex gap-3 rounded-lg p-2">{inner}</div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      ) : null}
    </div>
  )
}

export default SourcesPanel
