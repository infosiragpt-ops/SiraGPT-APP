"use client"

import * as React from "react"
import { Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { readComposerFastMode, writeComposerFastMode } from "@/lib/chat/composer-session"
import { cn } from "@/lib/utils"

export const EFFORT_LEVELS = [
  { value: "Bajo", label: "Bajo", caption: "Rápido y directo. Menos profundidad." },
  { value: "Medio", label: "Medio", caption: "Equilibrado. Ideal para el día a día." },
  { value: "Extra", label: "Extra high", caption: "Más profundidad y reflexión. Más lento." },
  { value: "Max", label: "Max", caption: "Máxima profundidad. Mayor costo y latencia." },
] as const

export function EffortSection({ selectedEffort, setSelectedEffort }: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
}) {
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((level) => level.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const draggingRef = React.useRef(false)
  const moveTo = (index: number) => {
    const clamped = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, index))
    if (clamped !== activeIndex) setSelectedEffort(EFFORT_LEVELS[clamped].value)
  }
  const indexFromPointer = (clientX: number) => {
    const track = trackRef.current
    if (!track) return activeIndex
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return activeIndex
    const fraction = (clientX - rect.left) / rect.width
    return Math.round(Math.min(1, Math.max(0, fraction)) * (EFFORT_LEVELS.length - 1))
  }
  return (
    <div className="effort-section" onClick={(event) => event.stopPropagation()}>
      <div className="effort-header">
        <span className="effort-title">Esfuerzo</span>
        <span className="effort-value">{active.label}</span>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Nivel de esfuerzo de razonamiento"
        aria-valuemin={0}
        aria-valuemax={EFFORT_LEVELS.length - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={active.label}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.pointerType === "mouse") return
          draggingRef.current = true
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older browsers */ }
          moveTo(indexFromPointer(event.clientX))
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return
          moveTo(indexFromPointer(event.clientX))
        }}
        onPointerUp={(event) => {
          draggingRef.current = false
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
        }}
        onPointerCancel={() => { draggingRef.current = false }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); moveTo(activeIndex + 1) }
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); moveTo(activeIndex - 1) }
          else if (event.key === "Home") { event.preventDefault(); moveTo(0) }
          else if (event.key === "End") { event.preventDefault(); moveTo(EFFORT_LEVELS.length - 1) }
        }}
      >
        <div className="effort-track-line" aria-hidden />
        <div
          className="effort-track-fill"
          aria-hidden
          style={{
            width:
              activeIndex <= 0
                ? "0px"
                : `calc((100% - var(--effort-stop-size, 1.75rem)) * ${activeIndex / (EFFORT_LEVELS.length - 1)})`,
          }}
        />
        {EFFORT_LEVELS.map((level, index) => (
          <button
            key={level.value}
            type="button"
            tabIndex={-1}
            aria-hidden
            title={level.label}
            className={cn(
              "effort-stop",
              index <= activeIndex && "effort-stop-reached",
              index === activeIndex && "effort-stop-active",
            )}
            onClick={() => moveTo(index)}
          />
        ))}
      </div>
      <p className="effort-caption">{active.caption}</p>
    </div>
  )
}

export function ComposerEffortMenu({
  selectedEffort,
  setSelectedEffort,
}: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [fast, setFast] = React.useState(false)
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((level) => level.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]

  React.useEffect(() => {
    setFast(readComposerFastMode())
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="composer-effort-cluster">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Esfuerzo de razonamiento"
            title={`${active.label}${fast ? " · Modo rápido" : ""}`}
            className="composer-effort-ring"
            data-testid="composer-effort-ring"
          >
            <span aria-hidden className="composer-effort-ring-meter" style={{ ["--effort" as string]: String(activeIndex / 3) }} />
          </button>
        </PopoverTrigger>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="composer-effort-chip"
            aria-label={`Esfuerzo: ${active.label}`}
            className={cn("composer-effort-chip", (active.value === "Extra" || active.value === "Max") && "is-high")}
          >
            <Zap className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
            <span className="truncate">{active.label}</span>
            <span aria-hidden className="composer-effort-caret">▾</span>
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="composer-effort-menu w-[min(calc(100vw-1.5rem),20rem)] p-3"
      >
        <EffortSection selectedEffort={selectedEffort} setSelectedEffort={setSelectedEffort} />
        <label className="composer-fast-row">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              <Zap className="h-3.5 w-3.5" strokeWidth={2.2} />
              Modo rápido
            </span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              Respuestas más rápidas, mayor uso de los límites.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={fast}
            data-testid="composer-fast-mode"
            className={cn("composer-fast-switch", fast && "is-on")}
            onClick={() => {
              const next = !fast
              setFast(next)
              writeComposerFastMode(next)
            }}
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}
