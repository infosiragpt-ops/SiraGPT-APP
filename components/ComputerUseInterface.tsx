"use client"

import React, { useRef } from "react"
import {
  Globe,
  Lock,
  Monitor,
  MousePointer2,
  Pause,
  Square,
  Undo2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  COMPUTER_USE_VIEWPORT,
  mapContainedImageClick,
  type BrowserControllerAction,
} from "@/lib/chat/browser-controller"

interface ComputerUseInterfaceProps {
  screenshot?: string | null
  status?: "idle" | "running" | "completed" | "error"
  currentUrl?: string | null
  actions?: BrowserControllerAction[]
  takeoverState?: "agent" | "user" | "required" | null
  onClose?: () => void
  onStop?: () => void
  onPause?: () => void
  onTakeover?: () => void
  onRelease?: () => void
  onUserClick?: (point: { x: number; y: number }) => void
  onUserType?: (text: string) => void
}

const ComputerUseInterface: React.FC<ComputerUseInterfaceProps> = ({
  screenshot,
  status = "idle",
  currentUrl = null,
  actions = [],
  takeoverState = "agent",
  onClose,
  onStop,
  onPause,
  onTakeover,
  onRelease,
  onUserClick,
  onUserType,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const userInControl = takeoverState === "user"
  const displayUrl = currentUrl || "about:blank"

  const handleViewportClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!userInControl || !onUserClick) return
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return
    const point = mapContainedImageClick(event.nativeEvent, rect, COMPUTER_USE_VIEWPORT)
    if (point) onUserClick(point)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!userInControl || !onUserType) return
    if (event.key === "Enter") {
      const value = event.currentTarget.value
      if (value.trim()) {
        onUserType(value)
        event.currentTarget.value = ""
      }
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background" data-testid="browser-controller">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Monitor className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-none">Controlador de navegador</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Mira y comprueba lo que hace el software
          </p>
        </div>
        <Badge
          variant={status === "error" ? "destructive" : status === "running" ? "default" : "secondary"}
        >
          {userInControl ? "tú controlas" : status}
        </Badge>
        {onClose && (
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Cerrar controlador">
            ×
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5">
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border/60 bg-background px-3 py-1">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs text-foreground" title={displayUrl}>
            {displayUrl}
          </span>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_10.5rem] lg:grid-cols-[minmax(0,1fr)_15.5rem] lg:grid-rows-none">
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-[220px] bg-muted",
            userInControl ? "cursor-crosshair" : "cursor-default",
          )}
          onClick={handleViewportClick}
        >
          {screenshot ? (
            // eslint-disable-next-line @next/next/no-img-element -- live computer-use screenshot stream
            <img
              src={screenshot}
              alt="Vista en vivo del navegador del agente"
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
              <Monitor className="h-10 w-10" />
              <p className="text-sm">La vista del navegador aparecerá aquí cuando el agente navegue.</p>
              <p className="text-xs">Activa Computer Use y envía una tarea para ver cada clic y página.</p>
            </div>
          )}
          {userInControl && (
            <div className="pointer-events-none absolute left-2 top-2 rounded-full bg-background/90 px-2 py-1 text-[11px] font-medium shadow-sm">
              Clic para pulsar · Enter para escribir
            </div>
          )}
        </div>

        <aside className="flex min-h-0 flex-col border-t border-border/50 lg:border-l lg:border-t-0">
          <div className="border-b border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground">
            Qué está haciendo
          </div>
          <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2">
            {actions.length === 0 ? (
              <li className="text-xs text-muted-foreground">Todavía no hay acciones.</li>
            ) : (
              [...actions].reverse().map((step) => (
                <li key={step.id} className="flex items-start gap-2 text-xs">
                  <MousePointer2 className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{step.label}</span>
                    {step.manual ? (
                      <span className="ml-1 text-muted-foreground">· tú</span>
                    ) : null}
                    <span className="ml-1 text-muted-foreground">
                      {new Date(step.timestamp).toLocaleTimeString()}
                    </span>
                  </span>
                </li>
              ))
            )}
          </ol>
        </aside>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
        {userInControl && (
          <input
            type="text"
            placeholder="Escribe y pulsa Enter"
            onKeyDown={handleKeyDown}
            className="h-8 min-w-[10rem] flex-1 rounded-md border border-border bg-background px-2 text-xs"
          />
        )}
        {onPause && status === "running" && !userInControl && (
          <Button type="button" variant="outline" size="sm" onClick={onPause}>
            <Pause className="mr-1 h-3.5 w-3.5" />
            Pausar
          </Button>
        )}
        {userInControl ? (
          <Button type="button" variant="outline" size="sm" onClick={onRelease}>
            <Undo2 className="mr-1 h-3.5 w-3.5" />
            Devolver al agente
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onTakeover}>
            <MousePointer2 className="mr-1 h-3.5 w-3.5" />
            Tomar control
          </Button>
        )}
        {onStop && (
          <Button type="button" variant="outline" size="sm" onClick={onStop}>
            <Square className="mr-1 h-3.5 w-3.5 fill-current" />
            Detener
          </Button>
        )}
      </div>
    </div>
  )
}

export default ComputerUseInterface
