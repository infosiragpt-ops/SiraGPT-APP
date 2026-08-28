"use client"

/**
 * PinnedAppRail — persistent app pins rendered as logo-only chips to the
 * right of the composer "+" button (spec §4.2). No app name, no handle:
 * just the brand mark, max 4, hover/focus/touch affordance to close.
 * Closing a chip NEVER disconnects the underlying OAuth connection.
 * Clicking the logo opens a minimal status popover (spec v2 §4.2).
 */

import * as React from "react"
import { ExternalLink, RefreshCw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  deriveChipStatus,
  type ChipStatus,
  type PinnedChipInput,
} from "@/lib/apps-pins"

export interface PinnedChipView {
  appId: string
  name: string
  /** Brand logo URL (local mark or brand favicon); falls back to initials + brand color. */
  logoUrl?: string | null
  logoSources?: string[]
  brandColor?: string
  availability?: string
  connectionStatus?: string | null
  connecting?: boolean
  expiresAt?: string | null
  lastError?: string | null
  /** Connected account label ("@jorge"), shown in the popover. */
  accountLabel?: string | null
  /** Connect/manage route for the popover's "Administrar conexión" action. */
  manageHref?: string
}

const STATUS_LABEL: Record<ChipStatus, string> = {
  active: "activo en este chat",
  loading: "conectando",
  warning: "atención",
  blocked: "no disponible",
}

const STATUS_DETAIL: Record<ChipStatus, string> = {
  active: "Esta app está fijada en este chat y sus herramientas están disponibles.",
  loading: "Conectando con esta app…",
  warning: "La conexión expira pronto o tiene un estado degradado.",
  blocked: "Esta app ya no está disponible o la sesión expiró. Reconecta para volver a usarla.",
}

function ChipFallback({ name, color }: { name: string; color?: string }) {
  const letters = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "A"
  return (
    <span
      aria-hidden="true"
      className="grid h-full w-full place-items-center text-[10px] font-semibold"
      style={{ color: color || "#18181b" }}
    >
      {letters}
    </span>
  )
}

function PinnedChip({
  chip,
  onUnpin,
  onOpenPopover,
}: {
  chip: PinnedChipView
  onUnpin: (appId: string) => void
  onOpenPopover: (chip: PinnedChipView) => void
}) {
  const status = deriveChipStatus(chip as PinnedChipInput)
  const sources = chip.logoSources?.length
    ? chip.logoSources
    : chip.logoUrl
      ? [chip.logoUrl]
      : []
  const [sourceIndex, setSourceIndex] = React.useState(0)
  const src = sources[sourceIndex]

  // Two sibling buttons (never nested): the logo chip opens the popover,
  // the close button unpins. Delete/Backspace on the focused chip unpins.
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault()
        onUnpin(chip.appId)
      }
    },
    [chip.appId, onUnpin],
  )

  return (
    <span
      className={cn(
        "pinned-chip-wrap relative inline-grid h-7 w-7 shrink-0 place-items-center",
        status === "blocked" && "opacity-70",
      )}
    >
      <button
        type="button"
        data-testid={`pinned-app-chip-${chip.appId}`}
        aria-label={`${chip.name}, ${STATUS_LABEL[status]}`}
        aria-haspopup="dialog"
        title={status === "blocked" ? `${chip.name} · no disponible` : chip.name}
        onClick={() => onOpenPopover(chip)}
        onKeyDown={handleKeyDown}
        className={cn(
          "pinned-chip grid h-7 w-7 place-items-center overflow-hidden rounded-full",
          "border border-black/5 bg-[#f4f4f5] transition-colors duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1",
          "dark:border-white/10 dark:bg-zinc-800",
          status === "warning" && "ring-1 ring-amber-400/70",
          status === "blocked" && "ring-1 ring-rose-400/70",
        )}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            width={20}
            height={20}
            loading="lazy"
            decoding="async"
            onError={() => setSourceIndex((index) => index + 1)}
            className="h-[70%] w-[70%] object-contain"
          />
        ) : (
          <ChipFallback name={chip.name} color={chip.brandColor} />
        )}
      </button>
      <button
        type="button"
        data-testid={`pinned-app-chip-close-${chip.appId}`}
        aria-label={`Quitar ${chip.name}`}
        title={`Quitar ${chip.name}`}
        onClick={(event) => {
          event.stopPropagation()
          onUnpin(chip.appId)
        }}
        className={cn(
          "pinned-chip-close absolute -right-1 -top-1 z-10 grid h-4 w-4 place-items-center rounded-full bg-zinc-900 text-white shadow-sm",
          "transition-opacity duration-150",
          "hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          "dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
        )}
      >
        <X className="h-2.5 w-2.5" aria-hidden="true" />
      </button>
    </span>
  )
}

function ChipPopover({
  chip,
  onClose,
  onUnpin,
  onReconnect,
}: {
  chip: PinnedChipView
  onClose: () => void
  onUnpin: (appId: string) => void
  onReconnect?: (chip: PinnedChipView) => void
}) {
  const status = deriveChipStatus(chip as PinnedChipInput)
  const ref = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const root = ref.current
      if (!root) return
      if (event.target instanceof Node && !root.contains(event.target)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [onClose])

  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onClose])

  React.useEffect(() => {
    // Focus management: focus the popover on open, restore to chip on close.
    const frame = window.requestAnimationFrame(() => {
      (ref.current?.querySelector("button") as HTMLButtonElement | null)?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${chip.name}, activa en este chat`}
      data-testid={`pinned-app-popover-${chip.appId}`}
      className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-border/60 bg-popover/95 p-3 shadow-xl backdrop-blur"
    >
      <div className="flex items-start gap-2.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-border/50 dark:bg-zinc-800">
          {chip.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={chip.logoUrl} alt="" width={22} height={22} className="h-[70%] w-[70%] object-contain" />
          ) : (
            <ChipFallback name={chip.name} color={chip.brandColor} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{chip.name}</p>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {STATUS_LABEL[status]}
            </span>
          </div>
          {chip.accountLabel ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{chip.accountLabel}</p>
          ) : null}
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{STATUS_DETAIL[status]}</p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          data-testid={`pinned-app-popover-unpin-${chip.appId}`}
          onClick={() => {
            onUnpin(chip.appId)
            onClose()
          }}
          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-lg border border-border/60 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="h-3 w-3" aria-hidden="true" />
          Quitar de este chat
        </button>
        {status === "blocked" && (
          <button
            type="button"
            data-testid={`pinned-app-popover-reconnect-${chip.appId}`}
            onClick={() => {
              onReconnect?.(chip)
              onClose()
            }}
            className="inline-flex h-7 items-center justify-center gap-1 rounded-lg bg-zinc-900 px-2 text-[11px] font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Reconectar
          </button>
        )}
        {chip.manageHref && (
          <a
            href={chip.manageHref}
            data-testid={`pinned-app-popover-manage-${chip.appId}`}
            className="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-border/60 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            Administrar
          </a>
        )}
      </div>
    </div>
  )
}

export function PinnedAppRail({
  chips,
  onUnpin,
  onOpenPopover,
  onReconnect,
  onOverflow,
}: {
  chips: PinnedChipView[]
  onUnpin: (appId: string) => void
  onOpenPopover?: (chip: PinnedChipView) => void
  onReconnect?: (chip: PinnedChipView) => void
  onOverflow?: (appId: string) => void
}) {
  const [popoverAppId, setPopoverAppId] = React.useState<string | null>(null)
  const announceRef = React.useRef<HTMLDivElement>(null)

  const handleUnpin = React.useCallback(
    (appId: string) => {
      const chip = chips.find((entry) => entry.appId === appId)
      if (announceRef.current) {
        announceRef.current.textContent = `${chip?.name || appId} quitado`
      }
      onUnpin(appId)
      setPopoverAppId(null)
    },
    [chips, onUnpin],
  )

  const openPopover = React.useCallback((chip: PinnedChipView) => {
    if (onOpenPopover) {
      onOpenPopover(chip)
      return
    }
    setPopoverAppId(chip.appId)
  }, [onOpenPopover])

  const activePopoverChip = popoverAppId
    ? chips.find((chip) => chip.appId === popoverAppId)
    : null

  if (!chips.length) return null

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 pl-2"
      data-testid="pinned-app-rail"
      aria-label="Apps fijadas en este chat"
    >
      <div aria-live="polite" className="sr-only" ref={announceRef} />
      {chips.slice(0, 4).map((chip) => (
        <PinnedChip
          key={chip.appId}
          chip={chip}
          onUnpin={handleUnpin}
          onOpenPopover={openPopover}
        />
      ))}
      {chips.length > 4 && onOverflow && (
        <span className="text-[10px] font-medium text-muted-foreground">
          +{chips.length - 4}
        </span>
      )}
      {activePopoverChip && (
        <ChipPopover
          chip={activePopoverChip}
          onClose={() => setPopoverAppId(null)}
          onUnpin={handleUnpin}
          onReconnect={onReconnect}
        />
      )}
    </div>
  )
}
