"use client"

import * as React from "react"
import { ChevronUp, SlidersHorizontal, Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EffortDitherTrack } from "@/components/chat/effort-dither-track"
import { readComposerFastMode, writeComposerFastMode } from "@/lib/chat/composer-session"
import { cn } from "@/lib/utils"

export const EFFORT_LEVELS = [
  { value: "Bajo", label: "Bajo", summary: "Ágil y directo", description: "Para preguntas sencillas y tareas del día a día." },
  { value: "Medio", label: "Medio", summary: "Un buen equilibrio", description: "Equilibra rapidez y análisis para el trabajo cotidiano." },
  { value: "Extra", label: "Alto", summary: "Análisis en profundidad", description: "Dedica más razonamiento a problemas de varios pasos." },
  { value: "Max", label: "Máximo", summary: "Para los retos más complejos", description: "Prioriza un análisis más exhaustivo; puede tardar más." },
] as const

/**
 * Four-stop effort slider.
 *
 * Visual contract (see globals.css `.effort-track*`):
 *   • fully rounded rail that starts grey and dissolves into violet through a
 *     dithered pixel grid (`EffortDitherTrack`, pure SVG — no raster asset);
 *   • the dither is anchored to the FULL rail and revealed up to the thumb
 *     with `clip-path`, so a higher effort literally uncovers more violet;
 *   • a white capsule thumb with a hairline border and a soft shadow marks
 *     the active stop; the remaining stops show as faint tick dots;
 *   • a light band travels the revealed region in a constant loop
 *     (`.effort-sheen`) so the bar feels alive while open.
 * The track itself is the pointer target, so taps and drags anywhere on the
 * rail snap to the nearest stop.
 */
export function EffortSection({ selectedEffort, setSelectedEffort }: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
}) {
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((level) => level.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const draggingRef = React.useRef(false)
  const descriptionId = React.useId()
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
        <span className="effort-header-icon" aria-hidden><SlidersHorizontal size={17} /></span>
        <div>
          <h3 className="effort-title">Esfuerzo de razonamiento</h3>
          <p className="effort-subtitle">Ajusta cuánto analiza Sira tu consulta.</p>
        </div>
      </div>
      <div className="effort-selection" aria-live="polite" aria-atomic="true">
        <div className="effort-selection-heading">
          <strong>{active.summary}</strong>
          <span className="effort-level-badge">{active.label}</span>
        </div>
        <p id={descriptionId}>{active.description}</p>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        data-effort={String(activeIndex)}
        data-testid="composer-effort-track"
        role="slider"
        tabIndex={0}
        aria-label="Nivel de esfuerzo de razonamiento"
        aria-valuemin={0}
        aria-valuemax={EFFORT_LEVELS.length - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={active.label}
        aria-describedby={descriptionId}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.pointerType === "mouse") return
          event.preventDefault()
          event.currentTarget.focus({ preventScroll: true })
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
        onLostPointerCapture={() => { draggingRef.current = false }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); moveTo(activeIndex + 1) }
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); moveTo(activeIndex - 1) }
          else if (event.key === "Home") { event.preventDefault(); moveTo(0) }
          else if (event.key === "End") { event.preventDefault(); moveTo(EFFORT_LEVELS.length - 1) }
        }}
      >
        <div className="effort-track-line" aria-hidden>
          <span className="effort-track-fill">
            <EffortDitherTrack className="effort-dither" />
            <span className="effort-sheen" aria-hidden />
          </span>
        </div>
        {EFFORT_LEVELS.map((level, index) => (
          <span
            key={level.value}
            aria-hidden
            data-stop={String(index)}
            className={cn(
              "effort-stop",
              index <= activeIndex && "effort-stop-reached",
              index === activeIndex && "effort-stop-active",
            )}
          />
        ))}
        <span className="effort-thumb" data-testid="composer-effort-thumb" aria-hidden />
      </div>
      <div className="effort-levels" role="group" aria-label="Elegir nivel de esfuerzo">
        {EFFORT_LEVELS.map((level, index) => (
          <button
            key={level.value}
            type="button"
            className="effort-level-button"
            aria-pressed={index === activeIndex}
            onClick={() => moveTo(index)}
          >
            {level.label}
          </button>
        ))}
      </div>
      <div className="effort-ends" aria-hidden>
        <span>Más rápido</span>
        <span>Más profundo</span>
      </div>
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
  const menuTitleId = React.useId()
  const fastLabelId = React.useId()
  const fastDescriptionId = React.useId()
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((level) => level.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]

  React.useEffect(() => {
    setFast(readComposerFastMode())
  }, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="composer-effort-chip"
          data-fast={fast}
          aria-label={`Esfuerzo: ${active.label}`}
          title={`Esfuerzo ${active.label}${fast ? " · Modo rápido activado" : ""}`}
          className={cn("composer-effort-chip", (active.value === "Extra" || active.value === "Max") && "is-high")}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />
          <span className="truncate">Esfuerzo <strong>{active.label}</strong></span>
          <ChevronUp aria-hidden className="composer-effort-caret" size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        collisionPadding={10}
        data-testid="composer-effort-menu"
        data-effort={String(activeIndex)}
        aria-labelledby={menuTitleId}
        className="composer-effort-menu w-[min(calc(100vw-1.25rem),22rem)] p-0"
      >
        <span id={menuTitleId} className="sr-only">Configurar esfuerzo de razonamiento</span>
        <EffortSection selectedEffort={selectedEffort} setSelectedEffort={setSelectedEffort} />
        <button
          type="button"
          role="switch"
          aria-labelledby={fastLabelId}
          aria-describedby={fastDescriptionId}
          aria-checked={fast}
          data-testid="composer-fast-mode"
          className="composer-fast-row"
          onClick={() => {
            const next = !fast
            setFast(next)
            writeComposerFastMode(next)
          }}
        >
          <span className="composer-fast-icon-wrap" aria-hidden>
            <Zap className="composer-fast-icon" size={17} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span id={fastLabelId} className="composer-fast-title">
              Modo rápido
            </span>
            <span id={fastDescriptionId} className="composer-fast-description">
              Respuestas más rápidas, mayor uso de los límites.
            </span>
          </span>
          <span
            aria-hidden
            className={cn("composer-fast-switch", fast && "is-on")}
          />
        </button>
      </PopoverContent>
    </Popover>
  )
}
