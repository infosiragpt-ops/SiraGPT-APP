"use client"

/**
 * Apps @ picker for the /agentes composer.
 * Mirrors SlashCommandMenu: popover above the textarea, keyboard nav, Spanish labels.
 */

import * as React from "react"
import { Check, Plug, PlugZap } from "lucide-react"
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

export function AppsMentionPicker({
  open,
  filter,
  apps,
  onPick,
  onClose,
}: AppsMentionPickerProps) {
  const [activeIdx, setActiveIdx] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement | null>(null)

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

  const connected = apps.filter((app) => app.status === "connected")
  const connect = apps.filter((app) => app.status === "connect")
  const unavailable = apps.filter((app) => app.status === "unavailable")

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
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {statusIcon(app.status)}
      </span>
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
    { title: MENTION_COPY.connectedGroup, items: connected },
    { title: MENTION_COPY.connectGroup, items: connect },
    { title: MENTION_COPY.unavailableGroup, items: unavailable },
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
      <div className="max-h-64 overflow-y-auto">
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
