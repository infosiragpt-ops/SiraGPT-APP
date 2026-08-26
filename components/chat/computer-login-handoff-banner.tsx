"use client"

/**
 * User-takeover chrome on the per-chat computer overlay.
 * Web + mobile: short Spanish instruction, large Listo tap target.
 * The user types on the live desktop; this chrome never captures keystrokes.
 */

import * as React from "react"
import { useTranslations } from "next-intl"
import { Lock } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  instructionForSite,
  LOGIN_HANDOFF_COPY,
  overlayLayoutContract,
} from "@/lib/computer-login-handoff"

export type ComputerLoginHandoffBannerProps = {
  active: boolean
  site?: string | null
  onReady: () => void
  viewportWidth?: number
}

export function ComputerLoginHandoffBanner({
  active,
  site,
  onReady,
  viewportWidth,
}: ComputerLoginHandoffBannerProps) {
  const t = useTranslations("codex.panel.agentComputer.loginHandoff")
  const [width, setWidth] = React.useState(
    typeof viewportWidth === "number"
      ? viewportWidth
      : typeof window !== "undefined"
        ? window.innerWidth
        : 1024,
  )

  React.useEffect(() => {
    if (typeof viewportWidth === "number") {
      setWidth(viewportWidth)
      return
    }
    if (typeof window === "undefined") return
    const onResize = () => setWidth(window.innerWidth)
    onResize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [viewportWidth])

  const layout = overlayLayoutContract(width)
  if (!active) return null

  const title = safeLabel(t, "title", LOGIN_HANDOFF_COPY.title)
  const neverSees = safeLabel(t, "neverSees", LOGIN_HANDOFF_COPY.neverSees)
  const ready = safeLabel(t, "ready", LOGIN_HANDOFF_COPY.ready)
  const instruction = site
    ? instructionForSite(site)
    : safeLabel(t, "instruction", LOGIN_HANDOFF_COPY.instruction)

  return (
    <div
      className={cn(
        "pointer-events-auto z-20 flex w-full shrink-0 items-center gap-3 border-b border-black/10 bg-white/95 px-3 py-2 text-zinc-800 shadow-sm backdrop-blur dark:border-white/10 dark:bg-[#1b1b1d]/95 dark:text-zinc-100",
        layout.mobile && "min-h-16 gap-3 px-4 py-3",
      )}
      data-testid="computer-login-handoff-banner"
      data-login-handoff="1"
      data-layout={layout.overlayPosition}
      data-full-screen={layout.fullScreen ? "1" : "0"}
      data-min-tap={String(layout.minTapPx)}
      role="status"
      aria-live="polite"
      style={{ minHeight: layout.bannerMinHeightPx }}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-300"
        aria-hidden
      >
        <Lock className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-tight" data-testid="computer-login-handoff-title">
          {title}
        </p>
        <p className="truncate text-[12px] leading-tight text-zinc-500 dark:text-zinc-400" data-testid="computer-login-handoff-instruction">
          {instruction}
        </p>
        <p className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400" data-testid="computer-login-handoff-privacy">
          {neverSees}
        </p>
      </div>
      <button
        type="button"
        onClick={onReady}
        data-testid="computer-login-handoff-ready"
        className={cn(
          "shrink-0 rounded-full bg-zinc-900 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
          "min-h-11 min-w-11",
        )}
        style={{ minHeight: layout.minTapPx, minWidth: Math.max(layout.minTapPx, 72) }}
        aria-label={ready}
      >
        {ready}
      </button>
    </div>
  )
}

function safeLabel(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  try {
    const value = t(key)
    if (!value || value === key || value.includes("MISSING_MESSAGE")) return fallback
    return value
  } catch {
    return fallback
  }
}
