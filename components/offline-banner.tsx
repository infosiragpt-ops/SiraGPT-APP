"use client"

/**
 * OfflineBanner — honest connectivity state for the whole app (Lote C ·
 * #16, reworked in the offline-honest-states pass).
 *
 * Shows a thin, persistent pill at the top of the viewport while the
 * browser reports `navigator.onLine === false`. Event-driven only — no
 * polling, no fetch, no extra network traffic. Hides itself the moment
 * connectivity is restored.
 *
 * When connectivity comes back AND there are queued chat messages that
 * failed while offline (lib/pending-messages), the banner offers a
 * "Reintentar" action instead of vanishing silently — the last failed
 * action is recoverable with one tap. The queue drains automatically on
 * `online` too (subscribeOnlineRetry); this button covers the manual /
 * policy-gated cases that auto-retry skips.
 *
 * Accessibility:
 *   · role="status" + aria-live="polite" so screen readers announce the
 *     loss / recovery without interrupting other speech.
 *   · Mobile-first: full-width-safe at 320px (max-w + truncate).
 *   · Light/dark via Tailwind dark: variants; respects
 *     prefers-reduced-motion via the global CSS rule that freezes
 *     transform animations.
 */

import * as React from "react"
import { RefreshCw, WifiOff } from "lucide-react"

import { useOnlineStatus } from "@/hooks/use-online-status"
import {
  getAll as getPendingMessages,
  retryAll,
  type PendingRetryResult,
} from "@/lib/pending-messages"
import type { PendingMessage } from "@/lib/pending-messages"
import { cn } from "@/lib/utils"

export function OfflineBanner() {
  const online = useOnlineStatus()

  // Pending messages that failed earlier (e.g. sent while offline) and can
  // be replayed now that we are back. Only surfaced right after recovery.
  const [pendingIds, setPendingIds] = React.useState<string[]>([])
  const [retrying, setRetrying] = React.useState(false)
  // Remember whether we were offline during this visit; a pending backlog
  // that predates the session should not trigger a surprise toast either way.
  const sawOfflineRef = React.useRef(false)

  React.useEffect(() => {
    if (!online) {
      sawOfflineRef.current = true
      return
    }
    if (!sawOfflineRef.current) return
    // Back online after an outage: offer one-tap recovery if anything is
    // still queued (auto-retry may already have drained part of it).
    try {
      setPendingIds(getPendingMessages().map((m: PendingMessage) => m.id))
    } catch {
      // Storage unavailable (private mode) — skip the recovery offer.
    }
  }, [online])

  const handleRetry = React.useCallback(async () => {
    if (retrying || pendingIds.length === 0) return
    setRetrying(true)
    try {
      const queued = new Set(pendingIds)
      // A `defer` disposition keeps the message queued untouched — it is
      // NOT a failure, so don't burn attempts on items we didn't handle.
      const sendFn = async (msg: PendingMessage): Promise<PendingRetryResult> =>
        queued.has(msg.id) ? "failure" : "defer"
      await retryAll(sendFn)
    } catch {
      // retryAll already persists per-item failure state; nothing to add.
    } finally {
      setRetrying(false)
      setPendingIds([])
    }
  }, [retrying, pendingIds])

  if (online && pendingIds.length === 0) return null

  if (online) {
    // Recovery offer — brief, dismisses itself once handled.
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="offline-banner-recovery"
        className="
          fixed left-1/2 top-3 z-[9999] w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2
          flex items-center gap-2 rounded-full
          border border-emerald-300/60 bg-emerald-50/95 px-4 py-1.5
          text-xs font-medium text-emerald-900 shadow-lg backdrop-blur
          dark:border-emerald-500/40 dark:bg-emerald-950/80 dark:text-emerald-100
        "
      >
        <RefreshCw className={cn("h-3.5 w-3.5 shrink-0", retrying && "animate-spin")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {retrying
            ? "Reenviando mensajes pendientes…"
            : `Conexión restablecida · ${pendingIds.length} mensaje${pendingIds.length === 1 ? "" : "s"} sin enviar`}
        </span>
        {!retrying && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            className="shrink-0 rounded-full bg-emerald-600/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-100"
          >
            Reintentar
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="
        fixed left-1/2 top-3 z-[9999] w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2
        flex items-center gap-2 rounded-full
        border border-amber-300/60 bg-amber-50/95 px-4 py-1.5
        text-xs font-medium text-amber-900 shadow-lg backdrop-blur
        dark:border-amber-500/40 dark:bg-amber-950/80 dark:text-amber-100
      "
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">Sin conexión — revisa tu red</span>
    </div>
  )
}
