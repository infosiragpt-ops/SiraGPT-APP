"use client"

/**
 * ThinkingPlaceholder — canonical "pensando" indicator used across
 * EVERY async activity in the chat (regular LLM stream, math solver,
 * viz generator, plan generator, figma/mermaid, etc.).
 *
 * Two modes — chosen automatically based on props:
 *   · passive (no `stage`/`pct`): shows the animated bars, and after
 *     ~3 s starts rotating a short product-neutral message in Spanish
 *     so the user knows the system is still working. This is what
 *     the plain chat stream uses while waiting for the first token.
 *   · progress (stage provided): shows the bars + the exact stage
 *     label + a progress bar. Used by the plan / math / viz
 *     dispatchers so the user sees granular feedback (e.g. "Ejecutado
 *     Python en 340 ms  ·  ▰▰▰▰▰▱▱▱▱▱ 50%").
 *
 * The bars themselves come from <ThinkingBarsIcon/> — a self-contained
 * SMIL-animated SVG, same one the user asked to standardise on.
 */

import { useEffect, useState } from "react"
import clsx from "clsx"
import { ThinkingBarsIcon } from "@/components/icons/thinking-bars-icon"

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

interface Props {
  // Explicit stage label — if provided, suppresses the rotating
  // copy and shows exactly this label instead. Typically comes from
  // an SSE event emitted by the plan / math / viz backend.
  stage?: string | null
  // Progress percentage 0..100. Shown as a 10-segment bar to the
  // right of the stage label. Omit for indeterminate progress.
  pct?: number | null
  // Compact = smaller bars + no min-height — used where we want the
  // indicator to sit inline in a tighter spot.
  compact?: boolean
  className?: string
}

export const ThinkingPlaceholder = ({ stage, pct, compact = false, className }: Props) => {
  const hasExplicitStage = typeof stage === "string" && stage.length > 0
  const [phase, setPhase] = useState<"dots" | "text">("dots")
  const [message, setMessage] = useState(ROTATING_MESSAGES[0])
  const [fade, setFade] = useState(false)

  // Passive mode: first ~3 s show just the bars, then rotate messages
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

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={hasExplicitStage ? stage! : "Generando respuesta"}
      className={clsx(
        "flex items-center gap-2.5 text-muted-foreground",
        compact ? "my-2" : "my-4",
        className,
      )}
    >
      <ThinkingBarsIcon
        className={clsx("shrink-0", compact ? "h-4 w-4" : "h-5 w-5")}
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
  )
}
