"use client"

/**
 * Apps @ picker for the /agentes composer.
 * Mirrors SlashCommandMenu: popover above the textarea, keyboard nav, Spanish labels.
 * With `enableSearchField` it renders a sticky search field (spec §4.1) that
 * debounces the live query to the composer, which feeds the same filter as
 * the `@token`.
 */

import * as React from "react"
import { Check, Plug, PlugZap, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  MENTION_COPY,
  type MentionPickerApp,
  type MentionAppStatus,
} from "@/lib/apps-mentions"

interface AppsMentionPickerProps {
  open: boolean
  filter: string
  apps: MentionPickerApp[]
  onPick: (app: MentionPickerApp) => void
  onClose: () => void
  /** Live search query owned by the composer (kept in sync with the @token). */
  onSearchChange?: (query: string) => void
  /** Sticky search field inside the panel. When unset the @token drives the filter. */
  enableSearchField?: boolean
  /** Apps currently pinned in this conversation — rendered as ACTIVAS group. */
  pinnedAppIds?: string[]
}

function statusIcon(status: MentionAppStatus) {
  if (status === "connected") return <Check className="h-3.5 w-3.5" />
  if (status === "connect") return <PlugZap className="h-3.5 w-3.5" />
  return <Plug className="h-3.5 w-3.5" />
}

function statusLabel(status: MentionAppStatus) {
  if (status === "connected") return MENTION_COPY.connected
  if (status === "connect") return MENTION_COPY.connect
  return MENTION_COPY.unavailable
}

function AppMentionLogo({ app }: { app: MentionPickerApp }) {
  const sources = app.logoSources?.length
    ? app.logoSources
    : app.logo
      ? [app.logo]
      : []
  const [sourceIndex, setSourceIndex] = React.useState(0)
  const src = sources[sourceIndex]

  if (src && sourceIndex < sources.length) {
    return (
      <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">
        <span className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-border/50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={`${app.name} logo`}
            width={28}
            height={28}
            data-testid={`apps-mention-logo-${app.id}`}
            loading="lazy"
            decoding="async"
            onError={() => setSourceIndex((index) => index + 1)}
            className="h-full w-full object-contain p-0.5"
          />
        </span>
        {app.status === "connected" ? (
          <span
            className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-popover"
            aria-hidden="true"
            data-testid={`apps-mention-status-${app.id}`}
          >
            <Check className="h-2.5 w-2.5" />
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
      {statusIcon(app.status)}
    </span>
  )
}

export function AppsMentionPicker({
  open,
  filter,
  apps,
  onPick,
  onClose,
  onSearchChange,
  enableSearchField = false,
  pinnedAppIds = [],
}: AppsMentionPickerProps) {
  const [activeIdx, setActiveIdx] = React.useState(0)
  const [searchDraft, setSearchDraft] = React.useState("")
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const searchDraftRef = React.useRef("")
  searchDraftRef.current = searchDraft

  // Sync the internal search field when the @token drives the query.
  React.useEffect(() => {
    if (enableSearchField && searchDraftRef.current !== filter) {
      setSearchDraft(filter)
    }
  }, [filter, enableSearchField])

  // Debounced (100ms) search — the catalog is local so filtering is cheap,
  // but keystroke-by-keystroke re-renders of the whole list still add up.
  React.useEffect(() => {
    if (!enableSearchField) return
    const timer = window.setTimeout(() => {
      onSearchChange?.(searchDraft)
    }, 100)
    return () => window.clearTimeout(timer)
  }, [searchDraft, enableSearchField, onSearchChange])

  React.useEffect(() => {
    if (!open) return
    if (enableSearchField) {
      const frame = window.requestAnimationFrame(() => {
        searchRef.current?.focus()
        searchRef.current?.select()
      })
      return () => window.cancelAnimationFrame(frame)
    }
  }, [open, enableSearchField])

  React.useEffect(() => {
    if (activeIdx >= apps.length) setActiveIdx(0)
  }, [apps.length, activeIdx])

  React.useEffect(() => {
    if (!open) setActiveIdx(0)
  }, [open, filter])

  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIdx((i) => (apps.length === 0 ? 0 : (i + 1) % apps.length))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIdx((i) => (apps.length === 0 ? 0 : (i - 1 + apps.length) % apps.length))
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (apps[activeIdx]) {
          e.preventDefault()
          onPick(apps[activeIdx])
        }
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, apps, activeIdx, onPick, onClose])

  React.useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      const root = rootRef.current
      if (!root) return
      if (event.target instanceof Node && !root.contains(event.target)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [open, onClose])

  if (!open) return null

  const grouped = {
    pinned: apps.filter((app) => pinnedAppIds.includes(app.id)),
    connected: apps.filter((app) => app.status === "connected" && !pinnedAppIds.includes(app.id)),
    connect: apps.filter((app) => app.status === "connect" && !pinnedAppIds.includes(app.id)),
    unavailable: apps.filter((app) => app.status === "unavailable" && !pinnedAppIds.includes(app.id)),
  }

  const renderRow = (app: MentionPickerApp, idx: number) => (
    <button
      key={app.id}
      id={`apps-mention-${app.id}`}
      type="button"
      role="option"
      aria-selected={idx === activeIdx}
      data-testid={`apps-mention-option-${app.id}`}
      onClick={() => onPick(app)}
      onMouseEnter={() => setActiveIdx(idx)}
      className={cn(
        "w-full flex items-start gap-3 px-3 py-2 text-left transition-colors",
        idx === activeIdx ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <AppMentionLogo app={app} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="font-medium text-sm text-foreground">@{app.name}</span>
          <span className="text-[11px] text-muted-foreground">{statusLabel(app.status)}</span>
        </span>
        <span className="block text-xs text-muted-foreground leading-snug mt-0.5 line-clamp-1">
          {app.status === "unavailable" ? MENTION_COPY.unavailableDetail(app.name) : app.description}
        </span>
      </span>
    </button>
  )

  let offset = 0
  const sections: Array<{ title: string; items: MentionPickerApp[] }> = [
    { title: MENTION_COPY.pinnedGroup, items: grouped.pinned },
    { title: MENTION_COPY.connectedGroup, items: grouped.connected },
    { title: MENTION_COPY.connectGroup, items: grouped.connect },
    { title: MENTION_COPY.unavailableGroup, items: grouped.unavailable },
  ]

  return (
    <div
      ref={rootRef}
      role="listbox"
      aria-label="Menciones de apps"
      aria-activedescendant={apps[activeIdx] ? `apps-mention-${apps[activeIdx].id}` : undefined}
      tabIndex={-1}
      data-testid="apps-mention-picker"
      className="absolute bottom-full mb-2 left-2 right-2 max-w-md rounded-xl border border-border/60 bg-popover/95 shadow-xl backdrop-blur z-50 overflow-hidden"
    >
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border/40">
        Apps
      </div>
      {enableSearchField && (
        <div className="relative border-b border-border/40 px-3 py-2">
          <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="apps-mention-list"
            aria-label="Buscar apps"
            placeholder="Buscar apps…"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setSearchDraft("")
                onClose()
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
                event.stopPropagation()
              }
            }}
            data-testid="apps-mention-search"
            className="h-8 w-full rounded-lg border border-border/50 bg-muted/40 pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60"
          />
        </div>
      )}
      <div id="apps-mention-list" className="max-h-64 overflow-y-auto">
        {apps.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{MENTION_COPY.empty}</div>
        ) : (
          sections.map((section) => {
            if (section.items.length === 0) return null
            const start = offset
            offset += section.items.length
            return (
              <div key={section.title}>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {section.title}
                </div>
                {section.items.map((app, i) => renderRow(app, start + i))}
              </div>
            )
          })
        )}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border/40 bg-muted/30">
        {MENTION_COPY.hint}
      </div>
    </div>
  )
}
