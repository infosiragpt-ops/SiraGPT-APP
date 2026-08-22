"use client"

/**
 * WaitingWithEscape — reusable "espera con salida" pattern (frente
 * "Cero spinners infinitos").
 *
 * A silent spinner with no ceiling reads as a frozen app. This component
 * renders NOTHING until the wait has genuinely exceeded `timeoutMs`; from
 * that moment it shows an honest status line plus escape actions so the
 * user is never trapped in an endless wait:
 *
 *   · "Cancelar"  — abandon the operation (calls onCancel).
 *   · "Reintentar" — retry the same operation (calls onRetry).
 *   · "Volver"    — go back / dismiss the surface (calls onBack).
 *
 * Any action handler that is not provided hides its button, so each call
 * site composes only the exits it can actually honour. The timer restarts
 * whenever `resetKey` changes — pass a value that advances when real
 * progress happens (tokens arriving, poll stage change) so the warning
 * only fires after a GENUINELY stalled wait.
 *
 * Accessibility: role="status" + aria-live="polite" announce the honest
 * copy without shouting over the screen reader; buttons keep a compact but
 * tappable height (min 32px) and the layout holds at 320px.
 */

import * as React from "react"
import { cn } from "@/lib/utils"

export const DEFAULT_WAIT_TIMEOUT_MS = 15_000

/**
 * Chat streaming: the honest stall budget for "no tokens yet". The
 * transport already auto-reconnects (up to ~20s backoff per attempt),
 * so this only fires when the user has genuinely seen nothing for 45s.
 */
export const STREAM_STALL_TIMEOUT_MS = 45_000
/** Preview start: npm install + dev-server boot; 20s is already "slow". */
export const PREVIEW_START_TIMEOUT_MS = 20_000
/** Attachment upload: big files on slow links legitimately take a while. */
export const UPLOAD_TIMEOUT_MS = 60_000

interface WaitingWithEscapeProps {
  /** How long the wait may stay silent before the honest copy appears. */
  timeoutMs?: number
  /**
   * Change this value to restart the timer — e.g. the number of tokens
   * received or the last observed progress. The escape UI only shows
   * after a genuinely stalled wait.
   */
  resetKey?: string | number | null
  /** Honest headline. Defaults to "Esto está tardando más de lo normal". */
  message?: string
  /** Secondary line explaining what the user can do about it. */
  description?: string
  onCancel?: () => void
  onRetry?: () => void
  onBack?: () => void
  cancelLabel?: string
  retryLabel?: string
  backLabel?: string
  className?: string
}

export function WaitingWithEscape({
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  resetKey = null,
  message = "Esto está tardando más de lo normal.",
  description,
  onCancel,
  onRetry,
  onBack,
  cancelLabel = "Cancelar",
  retryLabel = "Reintentar",
  backLabel = "Volver",
  className,
}: WaitingWithEscapeProps) {
  const [overdue, setOverdue] = React.useState(false)

  React.useEffect(() => {
    setOverdue(false)
    if (timeoutMs <= 0 || timeoutMs === Infinity) return
    const timer = window.setTimeout(() => setOverdue(true), timeoutMs)
    return () => window.clearTimeout(timer)
  }, [timeoutMs, resetKey])

  if (!overdue) return null

  const hasAnyAction = Boolean(onCancel || onRetry || onBack)

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="waiting-with-escape"
      className={cn(
        // Mobile-first: fits a 320px viewport, wraps gracefully on narrow screens.
        "mx-auto w-full max-w-sm rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3 py-2.5 text-center dark:border-amber-400/35 dark:bg-amber-400/[0.06]",
        className,
      )}
    >
      <p className="text-[12.5px] font-medium leading-snug text-foreground">
        {message}
      </p>
      {description ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      ) : null}
      {hasAnyAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-1 gap-y-1" role="group" aria-label="Acciones mientras esperas">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-[32px] items-center rounded-md border border-border/60 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {cancelLabel}
            </button>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-[32px] items-center rounded-md border border-border/60 bg-background px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {retryLabel}
            </button>
          ) : null}
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex min-h-[32px] items-center rounded-md px-3 py-1.5 text-[12px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {backLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default WaitingWithEscape

/**
 * useWaitResetKey — tiny helper for call sites whose "progress" is an
 * ever-growing buffer (streaming): derive a stable reset key from the
 * length so every real chunk of progress rearms the escape timer without
 * re-rendering on every byte.
 */
export function useWaitProgressKey(progressLength: number): number {
  // Quantise to 64-char buckets: a slow trickle still resets the clock,
  // but the key stays stable across sub-chunk re-renders.
  return Math.floor(Math.max(0, progressLength) / 64)
}
