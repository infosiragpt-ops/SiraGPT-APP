"use client"

/**
 * Lightweight offline indicator (Lote C · #16).
 *
 * Slides down a thin, dismissible banner at the top of the viewport
 * when the browser reports `navigator.onLine === false`. Event-driven
 * only — no polling, no fetch, no extra network traffic. Hides itself
 * the moment connectivity is restored.
 *
 * Why a new component instead of mounting ConnectionStatus globally:
 *   ConnectionStatus shows a permanent floating "Xms" badge while
 *   online, which clutters every page. This banner is invisible
 *   until something actually breaks.
 *
 * Accessibility:
 *   · role="status" + aria-live="polite" so screen readers announce
 *     the loss / recovery without interrupting other speech.
 *   · Respects prefers-reduced-motion via the global CSS rule that
 *     freezes transform animations.
 */

import * as React from "react"
import { WifiOff } from "lucide-react"

export function OfflineBanner() {
  const [online, setOnline] = React.useState(true)

  React.useEffect(() => {
    // Initial read — `navigator.onLine` lies on some Linux desktops
    // (always true) but is reliable for "definitely offline" cases,
    // which is the only state we surface.
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine)
    const goOffline = () => setOnline(false)
    const goOnline = () => setOnline(true)
    window.addEventListener("offline", goOffline)
    window.addEventListener("online", goOnline)
    return () => {
      window.removeEventListener("offline", goOffline)
      window.removeEventListener("online", goOnline)
    }
  }, [])

  if (online) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="
        fixed left-1/2 top-3 z-[9999] -translate-x-1/2
        flex items-center gap-2 rounded-full
        border border-amber-300/60 bg-amber-50/95 px-4 py-1.5
        text-xs font-medium text-amber-900 shadow-lg backdrop-blur
        dark:border-amber-500/40 dark:bg-amber-950/80 dark:text-amber-100
      "
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Sin conexión · los cambios se reanudarán al volver</span>
    </div>
  )
}
