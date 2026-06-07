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
import { Brain, Check, ExternalLink, Globe, Search, X } from "lucide-react"
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
  const hasSources = safeSources.length > 0
  const hasMemory = safeMemory.length > 0
  const memoryReason = memoryMeta?.reason || ""

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
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-violet-500/15 text-violet-600 dark:text-violet-400">
              <Brain className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
              MEMORIA
            </h3>
            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-400">
              {safeMemory.length}
            </span>
          </div>
          {memoryReason ? (
            <p className="mb-3 text-xs leading-5 text-muted-foreground">{memoryReason}</p>
          ) : null}
          <ul className="space-y-1.5">
            {safeMemory.map((m, i) => {
              const tierLabel = m.tier ? (MEMORY_TIER_LABEL[m.tier] || m.tier) : null
              return (
                <li
                  key={`mem-${i}`}
                  className="flex items-start gap-2.5 rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5"
                >
                  <Brain className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-violet-500/70" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-5 text-foreground">{m.fact}</p>
                    {(tierLabel || m.category) ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {tierLabel ? (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {tierLabel}
                          </span>
                        ) : null}
                        {m.category && m.category !== "general" ? (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {m.category}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
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
