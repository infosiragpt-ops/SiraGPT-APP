"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { usePrefersReducedMotion } from "@/lib/dotmatrix-hooks"
import {
  type LoaderState,
  LOADER_LABELS,
  SIRA_CELESTE,
  isTerminalLoaderState,
  loaderChipSrc,
  loaderIconSrc,
  loaderLabel,
  loaderSrc,
} from "@/lib/thinking-loaders"

export const COMPLETADO_FLASH_MS = 1200

export type ThinkingStatusLoaderProps = {
  state: LoaderState
  /** Overrides the kit Spanish label (human step text wins). */
  label?: string | null
  elapsedSec?: number | null
  compact?: boolean
  hideLabel?: boolean
  /** Set false when nested inside another role=status region. */
  announce?: boolean
  className?: string
  onSettled?: (state: Extract<LoaderState, "completado" | "error">) => void
}

function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/**
 * Status chip for Pensando / AgenticSteps / RunTrace header.
 * Renders the kit SVG from public/loaders/ so bounce geometry matches Luis's
 * snippet exactly. The step list (not this chip) keeps semantic colors —
 * running is --step-running blue, never brand-red.
 */
export function ThinkingStatusLoader({
  state,
  label,
  elapsedSec,
  compact = false,
  hideLabel = false,
  announce = true,
  className,
  onSettled,
}: ThinkingStatusLoaderProps) {
  const reduced = usePrefersReducedMotion()
  const text = loaderLabel(state, label)
  const terminal = isTerminalLoaderState(state)
  const elapsed =
    !terminal && typeof elapsedSec === "number" && elapsedSec >= 0 ? formatElapsed(elapsedSec) : null
  const src = reduced ? loaderIconSrc(state) : loaderChipSrc(state)

  React.useEffect(() => {
    if (!onSettled || (state !== "completado" && state !== "error")) return
    const settled = state
    const wait = settled === "completado" ? COMPLETADO_FLASH_MS : 0
    const id = window.setTimeout(() => onSettled(settled), wait)
    return () => window.clearTimeout(id)
  }, [onSettled, state])

  return (
    <div
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      aria-label={text}
      data-thinking-loader={state}
      data-loader-src={loaderSrc(state)}
      data-loader-chip={src}
      className={cn(
        "thinking-status-loader inline-flex min-w-0 items-center",
        compact ? "gap-2" : "gap-2.5",
        className,
      )}
      style={{ color: `var(--sira-celeste, ${SIRA_CELESTE})` }}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center",
          compact ? "h-7 w-7" : "h-8 w-8",
        )}
        aria-hidden="true"
      >
        {/* Kit SVG from /public — next/image adds nothing for 1KB SMIL swaps. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          width={compact ? 28 : 32}
          height={compact ? 28 : 32}
          className={cn(
            "pointer-events-none select-none object-contain",
            compact ? "h-7 w-7" : "h-8 w-8",
          )}
          draggable={false}
        />
      </span>
      {hideLabel ? null : (
        <span
          className={cn(
            "min-w-0 truncate font-sans tracking-[-0.01em]",
            compact ? "text-[13px] leading-5" : "text-[13.5px] font-medium leading-5",
            state === "error" ? "text-[var(--step-failed,#B45353)]" : "text-[var(--step-running,#38BDF8)]",
            state === "completado" && "text-[var(--step-done,#059669)]",
            !terminal && "thinking-shimmer-text",
          )}
        >
          {text}
        </span>
      )}
      {elapsed && !hideLabel ? (
        <span className="ml-1 shrink-0 font-sans text-[12px] tabular-nums leading-5 text-muted-foreground/70">
          {elapsed}
        </span>
      ) : null}
    </div>
  )
}

export function defaultLoaderLabel(state: LoaderState): string {
  return LOADER_LABELS[state]
}

export default ThinkingStatusLoader
