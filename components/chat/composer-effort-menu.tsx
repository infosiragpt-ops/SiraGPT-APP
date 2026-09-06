"use client"

import * as React from "react"
import { Zap } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EffortDitherTrack } from "@/components/chat/effort-dither-track"
import { readComposerFastMode, writeComposerFastMode } from "@/lib/chat/composer-session"
import { cn } from "@/lib/utils"

export const EFFORT_LEVELS = [
  { value: "Bajo", label: "Low" },
  { value: "Medio", label: "Medium" },
  { value: "Extra", label: "High" },
  { value: "Max", label: "Extra high" },
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
 * Discrete control with four fixed stops: taps and drags snap to the nearest
 * stop, tick marks under the rail show the steps, the header names the active
 * level in text (never color alone), and a bubble follows the thumb while
 * dragging. The title + value label the slider via `aria-labelledby`, so a
 * screen reader announces e.g. "Esfuerzo Extra high", never a bare number.
 * The track itself is the pointer target.
 */
export function EffortSection({ selectedEffort, setSelectedEffort, disabled = false }: {
  selectedEffort: string
  setSelectedEffort: (effort: string) => void
  disabled?: boolean
}) {
  const activeIndex = Math.max(0, EFFORT_LEVELS.findIndex((level) => level.value === selectedEffort))
  const active = EFFORT_LEVELS[activeIndex]
  const titleId = React.useId()
  const valueId = React.useId()
  const trackRef = React.useRef<HTMLDivElement | null>(null)
  const draggingRef = React.useRef(false)
  const [dragging, setDragging] = React.useState(false)
  const moveTo = (index: number) => {
    if (disabled) return
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
  const endDrag = () => {
    draggingRef.current = false
    setDragging(false)
  }
  return (
    <div className="effort-section" onClick={(event) => event.stopPropagation()}>
      <div className="effort-header">
        <span className="effort-title" id={titleId}>Esfuerzo</span>
        <span className="effort-level" id={valueId}>{active.label}</span>
      </div>
      <div
        ref={trackRef}
        className="effort-track"
        data-effort={String(activeIndex)}
        data-dragging={dragging ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
        data-testid="composer-effort-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${titleId} ${valueId}`}
        aria-valuemin={0}
        aria-valuemax={EFFORT_LEVELS.length - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={active.label}
        aria-orientation="horizontal"
        aria-disabled={disabled || undefined}
        onPointerDown={(event) => {
          if (disabled) return
          if (event.button !== 0 && event.pointerType === "mouse") return
          draggingRef.current = true
          setDragging(true)
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* older browsers */ }
          moveTo(indexFromPointer(event.clientX))
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return
          moveTo(indexFromPointer(event.clientX))
        }}
        onPointerUp={(event) => {
          endDrag()
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
        }}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowUp") { event.preventDefault(); moveTo(activeIndex + 1) }
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown") { event.preventDefault(); moveTo(activeIndex - 1) }
          else if (event.key === "PageUp") { event.preventDefault(); moveTo(activeIndex + 2) }
          else if (event.key === "PageDown") { event.preventDefault(); moveTo(activeIndex - 2) }
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
          <button
            key={level.value}
            type="button"
            tabIndex={-1}
            aria-hidden
            title={level.label}
            data-stop={String(index)}
            className={cn(
              "effort-stop",
              index <= activeIndex && "effort-stop-reached",
              index === activeIndex && "effort-stop-active",
            )}
            onClick={() => moveTo(index)}
          />
        ))}
        <span className="effort-thumb" data-testid="composer-effort-thumb" aria-hidden />
        {dragging && !disabled ? (
          <span className="effort-bubble" data-testid="composer-effort-bubble" aria-hidden>
            {active.label}
          </span>
        ) : null}
      </div>
      <div className="effort-ticks" aria-hidden>
        {EFFORT_LEVELS.map((level, index) => (
          <span key={level.value} data-stop={String(index)} />
        ))}
      </div>
      <div className="effort-ends" aria-hidden>
        <span>Más rápido</span>
        <span>Más inteligente</span>
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
          aria-label={`Esfuerzo: ${active.label}`}
          title={`${active.label}${fast ? " · Modo rápido" : ""}`}
          className={cn("composer-effort-chip", (active.value === "Extra" || active.value === "Max") && "is-high")}
        >
          <Zap className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        collisionPadding={10}
        data-testid="composer-effort-menu"
        data-effort={String(activeIndex)}
        className="composer-effort-menu w-[min(calc(100vw-1.25rem),20.75rem)] p-0"
      >
        <EffortSection selectedEffort={selectedEffort} setSelectedEffort={setSelectedEffort} />
        <div className="composer-fast-row">
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              <Zap className="composer-fast-icon h-4 w-4" fill="currentColor" strokeWidth={1.8} />
              Modo rápido
            </span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground">
              Respuestas más rápidas, mayor uso de los límites.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-label="Modo rápido"
            aria-checked={fast}
            data-testid="composer-fast-mode"
            className={cn("composer-fast-switch", fast && "is-on")}
            onClick={() => {
              const next = !fast
              setFast(next)
              writeComposerFastMode(next)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
