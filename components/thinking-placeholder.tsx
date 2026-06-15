"use client"

/**
 * ThinkingPlaceholder — canonical "pensando" indicator used across
 * EVERY async activity in the chat (regular LLM stream, math solver,
 * viz generator, plan generator, figma/mermaid, etc.).
 *
 * Renders a CHAINED thinking stream: every label the user has seen
 * (rotating copy in passive mode, or explicit SSE stage labels in
 * progress mode) stays on screen as a dimmed chain above the current
 * one, connected by a vertical rail. The current label carries the
 * DotmCircular15 "pensando" SVG — the single thinking glyph used
 * across the whole product.
 *
 * Two modes — chosen automatically based on props:
 *   · passive (no `stage`/`pct`): shows the dot-matrix, and after
 *     ~3 s starts chaining short product-neutral messages in Spanish
 *     so the user knows the system is still working.
 *   · progress (stage provided): chains the exact stage labels +
 *     optional progress bar. Used by the plan / math / viz
 *     dispatchers so the user sees granular feedback.
 */

import { useEffect, useRef, useState } from "react"
import clsx from "clsx"
import { DotmCircular15, THINKING_GLYPH_COLOR } from "@/components/ui/dotm-circular-15"

const ROTATING_MESSAGES = [
  "Pensando…",
  "Analizando tu mensaje…",
  "Procesando información…",
  "Construyendo la respuesta…",
  "Refinando la respuesta…",
  "Revisando el contexto…",
  "Resumiendo puntos clave…",
  "Verificando precisión…",
  "Casi listo…",
]

// How many completed (dimmed) chain entries stay visible above the
// active one. Older entries scroll out so the placeholder never grows
// past a handful of lines.
const MAX_CHAIN_HISTORY = 3

interface Props {
  // Explicit stage label — if provided, suppresses the rotating
  // copy and chains exactly these labels instead. Typically comes from
  // an SSE event emitted by the plan / math / viz backend.
  stage?: string | null
  // Progress percentage 0..100. Shown as a 10-segment bar to the
  // right of the stage label. Omit for indeterminate progress.
  pct?: number | null
  // Compact = smaller glyph + no chain history — used where we want
  // the indicator to sit inline in a tighter spot.
  compact?: boolean
  className?: string
}

export const ThinkingPlaceholder = ({ stage, pct, compact = false, className }: Props) => {
  const hasExplicitStage = typeof stage === "string" && stage.length > 0
  const [phase, setPhase] = useState<"dots" | "text">("dots")
  const [message, setMessage] = useState(ROTATING_MESSAGES[0])
  const [fade, setFade] = useState(false)
  // Chain of labels already shown (oldest → newest), excluding the
  // currently-active one.
  const [history, setHistory] = useState<string[]>([])
  const lastLabelRef = useRef<string | null>(null)

  // Track label transitions (explicit stages or rotated copy) and push
  // the previous label into the visible chain.
  const activeLabel = hasExplicitStage ? stage! : phase === "text" ? message : null
  useEffect(() => {
    if (!activeLabel) return
    const prev = lastLabelRef.current
    if (prev && prev !== activeLabel) {
      setHistory((h) => [...h, prev].slice(-MAX_CHAIN_HISTORY))
    }
    lastLabelRef.current = activeLabel
  }, [activeLabel])

  // Passive mode: first ~3 s show just the glyph, then chain messages
  // so the wait doesn't feel empty on long responses. When an
  // explicit stage is provided, we skip this entire machinery — the
  // backend is already telling us what's happening.
  useEffect(() => {
    if (hasExplicitStage) return
    if (phase === "dots") {
      const t = setTimeout(() => setPhase("text"), 3000)
      return () => clearTimeout(t)
    }
  }, [phase, hasExplicitStage])

  useEffect(() => {
    if (hasExplicitStage) return
    if (phase === "text") {
      let i = 0
      const interval = setInterval(() => {
        setFade(true)
        setTimeout(() => {
          i = (i + 1) % ROTATING_MESSAGES.length
          setMessage(ROTATING_MESSAGES[i])
          setFade(false)
        }, 400)
      }, 2500)
      return () => clearInterval(interval)
    }
  }, [phase, hasExplicitStage])

  // Build the progress bar segments. 10 cells, each representing 10%.
  const pctClamped = typeof pct === "number"
    ? Math.max(0, Math.min(100, pct))
    : null
  const filledCells = pctClamped !== null ? Math.round(pctClamped / 10) : 0

  const showChain = !compact && history.length > 0
  const glyphSize = compact ? 16 : 20
  const glyphDot = compact ? 2 : 3

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={activeLabel ?? "Generando respuesta"}
      className={clsx(
        "flex flex-col text-muted-foreground",
        compact ? "my-2" : "my-4",
        className,
      )}
    >
      {showChain && (
        <div className="mb-1.5 flex flex-col gap-1" aria-hidden="true">
          {history.map((label, i) => (
            <div key={`${i}-${label}`} className="flex items-center gap-2.5">
              {/* Connector node aligned with the glyph column below. */}
              <span
                className="flex shrink-0 items-center justify-center"
                style={{ width: glyphSize }}
              >
                <span className="block h-[5px] w-[5px] rounded-full bg-foreground/25" />
              </span>
              <span
                className={clsx(
                  "truncate text-[12.5px] font-medium tracking-tight",
                  // Older entries fade harder so the chain reads as a
                  // stream flowing into the active thought.
                  i === history.length - 1 ? "text-foreground/45" : "text-foreground/25",
                )}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2.5">
        <DotmCircular15
          size={glyphSize}
          dotSize={glyphDot}
          color={THINKING_GLYPH_COLOR}
          ariaLabel={activeLabel ?? "Generando respuesta"}
          className="shrink-0"
        />

        {hasExplicitStage ? (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="truncate text-[13.5px] font-medium tracking-tight text-foreground/85">
              {stage}
            </span>
            {pctClamped !== null && (
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex gap-[2px]">
                  {Array.from({ length: 10 }, (_, i) => (
                    <span
                      key={i}
                      className={clsx(
                        "block h-[6px] w-[6px] rounded-[1.5px] transition-colors duration-200",
                        i < filledCells
                          ? "bg-foreground/75"
                          : "bg-foreground/12",
                      )}
                    />
                  ))}
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground/75">
                  {pctClamped}%
                </span>
              </div>
            )}
          </div>
        ) : (
          phase === "text" && (
            <p
              className={clsx(
                "text-[13.5px] font-medium tracking-tight transition-all duration-300",
                fade ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0",
              )}
            >
              {message}
            </p>
          )
        )}
      </div>
    </div>
  )
}
