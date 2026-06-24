"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Globe, X, Search, Check, ExternalLink, Brain } from "lucide-react"
import { cn } from "@/lib/utils"

export type ChipSource = {
  title: string
  url: string
  snippet?: string
  domain?: string
  confidence?: string
}

export type ChipActivity = {
  provider?: string
  query?: string
  elapsedMs?: number
} | null

export type ChipMemoryItem = {
  id?: string
  fact: string
  category?: string
  tier?: string
  polarity?: string
  confidence?: number | null
  relevance?: number | null
  matchedTopics?: string[]
  semantic?: number | null
  why?: string
  ageMs?: number | null
  strength?: number | null
  score?: number | null
}

export type ChipMemoryMeta = {
  reason?: string
  confidence?: number | null
  recalled?: number
} | null

interface SourcesChipProps {
  sources: ChipSource[]
  activity?: ChipActivity
  /** Autonomously-recalled memory items surfaced for this turn (optional). */
  memory?: ChipMemoryItem[]
  memoryMeta?: ChipMemoryMeta
  /**
   * When provided, clicking the chip opens the integrated right-side panel
   * (the chat's resizable pane) instead of the self-contained portal drawer.
   * The drawer stays as a fallback for read-only contexts (e.g. share pages)
   * where no panel host is mounted.
   */
  onOpenSources?: (payload: { sources: ChipSource[]; activity: ChipActivity; memory?: ChipMemoryItem[]; memoryMeta?: ChipMemoryMeta }) => void
}

export function domainOf(s: ChipSource): string {
  if (s.domain) return s.domain
  try {
    return new URL(s.url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function faviconUrl(domain: string): string {
  if (!domain) return ""
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`
}

/**
 * Sources come from untrusted web-search results. Only allow http(s) URLs so a
 * malicious result can't smuggle a `javascript:`/`data:` scheme into an anchor
 * href and run script on click. Returns null for anything unsafe/unparseable.
 */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null
  } catch {
    return null
  }
}

export function formatElapsed(ms?: number): string {
  if (!ms || ms < 0) return ""
  const secs = Math.max(1, Math.round(ms / 1000))
  return `${secs}s`
}

/** Small favicon with a graceful fallback to a globe glyph. */
export function Favicon({ domain, size = 16 }: { domain: string; size?: number }) {
  const [failed, setFailed] = React.useState(false)
  const src = faviconUrl(domain)
  if (failed || !src) {
    return (
      <span
        className="flex items-center justify-center rounded-full bg-muted text-muted-foreground"
        style={{ width: size, height: size }}
      >
        <Globe style={{ width: size * 0.7, height: size * 0.7 }} />
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="rounded-full bg-white object-contain"
      style={{ width: size, height: size }}
    />
  )
}

export function SourcesChip({ sources, activity, memory, memoryMeta, onOpenSources }: SourcesChipProps) {
  const [open, setOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  // Lock body scroll while the drawer is open (mobile-friendly).
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const safeSources = Array.isArray(sources) ? sources : []
  const safeMemory = Array.isArray(memory) ? memory : []
  // Show the chip when the turn produced web sources OR recalled memory.
  if (safeSources.length === 0 && safeMemory.length === 0) return null

  const domains = safeSources.map(domainOf)
  const uniqueDomains = Array.from(new Set(domains.filter(Boolean)))
  const previewDomains = uniqueDomains.slice(0, 3)
  const elapsed = formatElapsed(activity?.elapsedMs)
  const query = activity?.query || ""
  const hasSources = safeSources.length > 0
  const hasMemory = safeMemory.length > 0

  const drawer =
    mounted && open
      ? createPortal(
          <div className="fixed inset-0 z-[120] flex justify-end">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/30 backdrop-blur-[1px] animate-in fade-in duration-200"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            {/* Panel */}
            <aside
              role="dialog"
              aria-label="Actividad de fuentes"
              className="relative h-full w-full max-w-[400px] overflow-y-auto border-l border-border bg-background shadow-2xl animate-in slide-in-from-right duration-300"
            >
              {/* Header */}
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-5 py-4 backdrop-blur">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-base font-semibold text-foreground">Actividad</h2>
                  {elapsed ? (
                    <span className="text-sm text-muted-foreground">· {elapsed}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
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
                      Analizando {sources.length}{" "}
                      {sources.length === 1 ? "fuente encontrada" : "fuentes encontradas"}
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
                <h3 className="mb-3 text-sm font-semibold text-foreground">
                  Fuentes · {sources.length}
                </h3>
                <ul className="space-y-1">
                  {sources.map((s, i) => {
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
                            <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                              {s.snippet}
                            </span>
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
            </aside>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (onOpenSources) onOpenSources({ sources: safeSources, activity: activity ?? null, memory: safeMemory, memoryMeta: memoryMeta ?? null })
          else setOpen(true)
        }}
        title={hasSources ? `Ver ${safeSources.length} fuentes${hasMemory ? ` y ${safeMemory.length} de memoria` : ""}` : `Ver ${safeMemory.length} de memoria`}
        aria-label={hasSources ? `Ver ${safeSources.length} fuentes${hasMemory ? ` y ${safeMemory.length} memorias` : ""}` : `Ver ${safeMemory.length} memorias`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
          "hover:bg-muted hover:text-foreground",
        )}
      >
        {hasSources ? (
          <>
            <span className="flex items-center">
              {previewDomains.map((d, i) => (
                <span
                  key={d}
                  className="rounded-full ring-2 ring-background"
                  style={{ marginLeft: i === 0 ? 0 : -6, zIndex: previewDomains.length - i }}
                >
                  <Favicon domain={d} size={16} />
                </span>
              ))}
            </span>
            <span>Fuentes {safeSources.length}</span>
            {hasMemory ? (
              <span className="ml-0.5 inline-flex items-center gap-1 border-l border-border pl-1.5 text-violet-600 dark:text-violet-400">
                <Brain className="h-3.5 w-3.5" />
                {safeMemory.length}
              </span>
            ) : null}
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-violet-600 dark:text-violet-400">
            <Brain className="h-3.5 w-3.5" />
            Memoria {safeMemory.length}
          </span>
        )}
      </button>
      {drawer}
    </>
  )
}

export default SourcesChip
