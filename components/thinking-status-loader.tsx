"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { PensandoBars } from "@/components/pensando-bars"
import {
  type LoaderState,
  LOADER_LABELS,
  CLAUDE_THINK_ACCENT,
  THINKING_ANNOUNCE_INTERVAL_MS,
  THINKING_LIVE_PHRASES,
  THINKING_PHRASE_INTERVAL_MS,
  formatThinkingElapsed,
  isTerminalLoaderState,
  loaderChipSrc,
  loaderLabel,
  loaderSrc,
  nextThinkingPhraseIndex,
} from "@/lib/thinking-loaders"

export const COMPLETADO_FLASH_MS = 1200

export type ThinkingStatusLoaderDensity = "chip" | "glyph"

export type ThinkingStatusLoaderProps = {
  state: LoaderState
  /** Overrides the kit Spanish label (human step text wins). */
  label?: string | null
  elapsedSec?: number | null
  compact?: boolean
  /** `glyph` is the 16px rail dot; `chip` is the 22px header/status size. */
  density?: ThinkingStatusLoaderDensity
  hideLabel?: boolean
  /** Set false when nested inside another role=status region. */
  announce?: boolean
  /**
   * The caller announces this status itself (its own throttled live region):
   * no screen-reader copy here, the chip is decorative.
   */
  silent?: boolean
  /** Root element: `span` inside a button / summary (phrasing content only). */
  as?: "div" | "span"
  className?: string
  onSettled?: (state: Extract<LoaderState, "completado" | "error">) => void
}

function formatElapsed(sec: number): string {
  return formatThinkingElapsed(sec)
}

/**
 * Rotating «Pensando…» phrase (every THINKING_PHRASE_INTERVAL_MS, never the
 * same twice in a row). Starts on the canonical «Pensando…» so the first
 * paint matches the kit label; inactive → always the first phrase.
 */
function useThinkingLivePhrase(enabled: boolean): string {
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    if (!enabled) return
    setIndex(0)
    const id = window.setInterval(() => setIndex((prev) => nextThinkingPhraseIndex(prev)), THINKING_PHRASE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [enabled])
  return THINKING_LIVE_PHRASES[enabled ? index : 0]
}

/** Seconds since the live label mounted — fallback when the caller passes no elapsedSec. */
function useFallbackElapsed(enabled: boolean): number {
  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!enabled) return
    const started = Date.now()
    setElapsed(0)
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [enabled])
  return enabled ? elapsed : 0
}

/** Two step announcements are never closer than this (ms). */
const ANNOUNCE_MIN_GAP_MS = 1500

/**
 * Throttled copy of `text` for screen readers (updates every
 * THINKING_ANNOUNCE_INTERVAL_MS). A new step (`key` change) is announced right
 * away, at most once per ANNOUNCE_MIN_GAP_MS; elapsed seconds and live counts
 * only move on the throttle tick.
 */
export function useThrottledAnnouncement(text: string, enabled: boolean, key = ""): string {
  const [announced, setAnnounced] = React.useState(text)
  const latest = React.useRef(text)
  latest.current = text
  const lastAt = React.useRef(0)
  const lastKey = React.useRef(key)
  React.useEffect(() => {
    if (!enabled) {
      setAnnounced(text)
      return
    }
    const id = window.setInterval(() => {
      lastAt.current = Date.now()
      setAnnounced(latest.current)
    }, THINKING_ANNOUNCE_INTERVAL_MS)
    return () => window.clearInterval(id)
    // `text` intentionally omitted: while live, announcements only move on the throttle tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])
  React.useEffect(() => {
    if (!enabled || !key || key === lastKey.current) return
    lastKey.current = key
    if (Date.now() - lastAt.current < ANNOUNCE_MIN_GAP_MS) return
    lastAt.current = Date.now()
    setAnnounced(latest.current)
  }, [enabled, key])
  return enabled ? announced : text
}

/** Announcement identity of a label: digits (counts, sizes) do not make a new step. */
export function announcementKey(text: string): string {
  return text.replace(/[\d.,]+/g, "#").replace(/\s+/g, " ").trim()
}

function TerminalGlyph({ state, px }: { state: "completado" | "error"; px: number }) {
  const failed = state === "error"
  return (
    <svg
      viewBox="0 0 16 16"
      width={px}
      height={px}
      aria-hidden="true"
      data-thinking-loader-glyph={state}
      className="pointer-events-none select-none"
      style={{ width: px, height: px, color: failed ? "var(--step-failed,#B45353)" : "var(--step-done,#6B6660)" }}
    >
      {failed ? (
        <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : (
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

/**
 * Status chip for Pensando / AgenticSteps / RunTrace header.
 * In-progress always uses PensandoBars (the ThinkingCore glyph, monochrome:
 * `--think-accent` is the foreground — black on light, white on dark).
 * Terminal states draw a quiet check / X in currentColor. Labels are a muted
 * neutral grey (`--think-text`), never brand colours.
 *
 * With a real step label («Leyendo «contrato.pdf»») the chip shows it with
 * «· 12 s» for that step. Only a bare «Pensando…» (state `pensando`, no label)
 * falls back to cycling a short phrase every ~3.5 s. While in progress the
 * visual text is aria-hidden; a visually-hidden node announces a new step
 * right away and the ticking seconds only every ~10 s, so `aria-live` regions
 * are not spammed.
 */
const DENSITY_PX: Record<ThinkingStatusLoaderDensity, number> = {
  chip: 22,
  glyph: 16,
}

export function ThinkingStatusLoader({
  state,
  label,
  elapsedSec,
  compact = false,
  density,
  hideLabel = false,
  announce = true,
  silent = false,
  as: Root = "div",
  className,
  onSettled,
}: ThinkingStatusLoaderProps) {
  const baseText = loaderLabel(state, label)
  const terminal = isTerminalLoaderState(state)
  const resolvedDensity: ThinkingStatusLoaderDensity = density || "chip"
  const glyph = resolvedDensity === "glyph"
  const px = glyph ? DENSITY_PX.glyph : compact ? 28 : DENSITY_PX.chip
  const explicitLabel = String(label || "").trim().length > 0
  const live = state === "pensando" && !terminal && !hideLabel && !explicitLabel
  const ticking = !terminal && !hideLabel
  const phrase = useThinkingLivePhrase(live)
  const fallbackElapsed = useFallbackElapsed(live && typeof elapsedSec !== "number")
  const elapsedValue =
    !terminal && typeof elapsedSec === "number" && elapsedSec >= 0 ? elapsedSec : live ? fallbackElapsed : null
  const elapsed = elapsedValue === null ? null : formatElapsed(elapsedValue)
  const text = live ? phrase : baseText
  const spoken = elapsed ? `${text} ${elapsed}` : text
  const announced = useThrottledAnnouncement(spoken, ticking && !silent, live ? "" : announcementKey(text))
  const chip = loaderChipSrc(state)

  React.useEffect(() => {
    if (!onSettled || (state !== "completado" && state !== "error")) return
    const settled = state
    const wait = settled === "completado" ? COMPLETADO_FLASH_MS : 0
    const id = window.setTimeout(() => onSettled(settled), wait)
    return () => window.clearTimeout(id)
  }, [onSettled, state])

  return (
    <Root
      role={announce && !silent ? "status" : undefined}
      aria-live={announce && !silent ? "polite" : undefined}
      aria-atomic={announce ? true : undefined}
      aria-label={silent ? undefined : ticking ? announced : baseText}
      aria-hidden={silent ? true : undefined}
      data-thinking-loader={state}
      data-thinking-live={live ? "1" : undefined}
      data-loader-src={terminal ? loaderSrc(state) : chip}
      data-loader-chip={chip}
      data-pensando-bars={terminal ? undefined : "1"}
      className={cn(
        "thinking-status-loader inline-flex min-w-0 items-center",
        glyph ? "gap-0" : compact ? "gap-2" : "gap-2.5",
        className,
      )}
      style={{ color: `var(--think-accent, ${CLAUDE_THINK_ACCENT})` }}
    >
      <span
        className="flex shrink-0 items-center justify-center"
        style={{ width: px, height: px }}
        aria-hidden="true"
      >
        {terminal ? (
          <TerminalGlyph state={state === "error" ? "error" : "completado"} px={px} />
        ) : (
          <PensandoBars size={px} className="pointer-events-none select-none" />
        )}
      </span>
      {hideLabel ? null : (
        <span
          aria-hidden={ticking ? true : undefined}
          data-thinking-phrase={live ? text : undefined}
          className={cn(
            "min-w-0 truncate font-sans tracking-[-0.01em]",
            compact ? "text-[13px] leading-5" : "text-[13.5px] font-normal leading-5",
            state === "error" ? "text-[var(--step-failed,#B45353)]" : "text-[var(--think-text,#57534E)]",
            state === "completado" && "text-[var(--step-done,#6B6660)]",
            !terminal && "thinking-shimmer-text",
            live && "thinking-live-label",
          )}
        >
          {text}
        </span>
      )}
      {elapsed && !hideLabel ? (
        <span
          aria-hidden={ticking ? true : undefined}
          data-thinking-elapsed={ticking ? elapsedValue ?? undefined : undefined}
          className="-ml-1 shrink-0 font-sans text-[12px] tabular-nums leading-5 text-[var(--think-dim,#78716C)]"
        >
          {`· ${elapsed}`}
        </span>
      ) : null}
      {ticking && !silent ? (
        /* Read by the enclosing live region (this chip or the timeline); the
           visual phrase/elapsed spans above are aria-hidden so only this
           throttled copy reaches screen readers. */
        <span className="sr-only" data-thinking-announce="1">
          {announced}
        </span>
      ) : null}
    </Root>
  )
}

export function defaultLoaderLabel(state: LoaderState): string {
  return LOADER_LABELS[state]
}

export default ThinkingStatusLoader
