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
import { Check, ExternalLink, Globe, Search, X } from "lucide-react"
import {
  Favicon,
  domainOf,
  formatElapsed,
  safeHref,
  type ChipActivity,
  type ChipSource,
} from "@/components/SourcesChip"

interface SourcesPanelProps {
  sources: ChipSource[]
  activity?: ChipActivity
  onClose: () => void
}

export function SourcesPanel({ sources, activity, onClose }: SourcesPanelProps) {
  const safeSources = React.useMemo(
    () => (Array.isArray(sources) ? sources.filter(Boolean) : []),
    [sources],
  )
  const domains = React.useMemo(() => safeSources.map(domainOf), [safeSources])
  const uniqueDomains = React.useMemo(
    () => Array.from(new Set(domains.filter(Boolean))),
    [domains],
  )
  const previewDomains = uniqueDomains.slice(0, 3)
  const elapsed = formatElapsed(activity?.elapsedMs)
  const query = activity?.query || ""

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

      {/* Thinking / steps */}
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

      {/* Sources list */}
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
    </div>
  )
}

export default SourcesPanel
