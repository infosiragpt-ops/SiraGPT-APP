"use client"

import * as React from "react"
import { ImageIcon, Mic, MoreHorizontal, Music, Video } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MEDIA_LAUNCH_LABELS, MEDIA_LAUNCH_MODES } from "@/lib/chat/media-mode-launch"
import type { MediaMode } from "@/lib/chat/media-mode-chips"
import { cn } from "@/lib/utils"

const MEDIA_ICONS: Record<MediaMode, React.ComponentType<{ className?: string }>> = {
  video: Video,
  voice: Mic,
  image: ImageIcon,
  music: Music,
}

const MEDIA_HINTS: Record<MediaMode, string> = {
  video: "Genera un video a partir de texto",
  voice: "Convierte texto en voz",
  image: "Crea o edita imágenes",
  music: "Compón una canción o pista",
}

/**
 * «··· Más» row under Empresas: a flyout with the media modes (Video, Voz,
 * Imagen, Música). Picking one starts a fresh chat with that mode selected in
 * the composer; the sidebar owns the new-chat flow (`onSelect`).
 */
export function SidebarMoreMedia({
  rowClassName,
  activeRowClassName,
  iconClassName,
  sidebarState,
  isMobile,
  onSelect,
}: {
  rowClassName: string
  activeRowClassName: string
  iconClassName: string
  sidebarState: "open" | "closed"
  isMobile: boolean
  onSelect: (mode: MediaMode) => void
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sidebar-more-media"
          aria-label="Más"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            rowClassName,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            "group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2",
            open && activeRowClassName,
          )}
        >
          <MoreHorizontal className={cn(iconClassName, open ? "text-foreground" : "text-muted-foreground")} />
          <span className={cn("truncate", sidebarState === "closed" && "hidden")}>Más</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={isMobile ? "bottom" : "right"}
        align="start"
        sideOffset={isMobile ? 6 : 10}
        role="menu"
        aria-label="Crear contenido"
        data-testid="sidebar-more-media-panel"
        className="w-[248px] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-lg)]"
      >
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">Crear</div>
        {MEDIA_LAUNCH_MODES.map((mode) => {
          const Icon = MEDIA_ICONS[mode]
          return (
            <button
              key={mode}
              type="button"
              role="menuitem"
              data-testid={`sidebar-more-media-${mode}`}
              onClick={() => {
                setOpen(false)
                onSelect(mode)
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-tight text-foreground">
                  {MEDIA_LAUNCH_LABELS[mode]}
                </span>
                <span className="block truncate text-[11.5px] leading-tight text-muted-foreground">
                  {MEDIA_HINTS[mode]}
                </span>
              </span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
