"use client"

/**
 * PWA Install Prompt — non-intrusive banner.
 *
 * Activation rules (all must be true):
 *   - `beforeinstallprompt` event has fired (browser deems app installable)
 *   - 30s+ of session time elapsed
 *   - User has interacted with at least 3 chat messages (props `interactionCount`)
 *   - User has not previously dismissed permanently
 *
 * IMPORTANT: This component is NOT auto-wired into the chat UI per CLAUDE.md
 * rule #1 (no UI changes). It is exposed here for future opt-in integration.
 *
 * Usage (when ready):
 *   <PWAInstallPrompt interactionCount={messages.length} />
 */

import { useEffect, useState, useCallback } from "react"

const DISMISS_KEY = "siragpt.pwa.installPrompt.dismissedPermanently"
const SESSION_KEY = "siragpt.pwa.installPrompt.sessionDismissed"
const MIN_VISIBLE_DELAY_MS = 30_000
const MIN_INTERACTIONS = 3

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
}

export type PWAInstallPromptProps = {
  /** Number of chat messages the user has engaged with this session. */
  interactionCount?: number
  /** Override the minimum interaction threshold (default 3). */
  minInteractions?: number
  /** Override the minimum visible delay (default 30000ms). */
  minDelayMs?: number
  /** Called when user accepts install. */
  onInstalled?: () => void
  /** Called when user dismisses (either temporarily or permanently). */
  onDismissed?: (permanent: boolean) => void
  /** Extra className for the wrapper. */
  className?: string
}

function readDismissed(): { permanent: boolean; session: boolean } {
  try {
    const permanent =
      typeof window !== "undefined" && window.localStorage?.getItem(DISMISS_KEY) === "1"
    const session =
      typeof window !== "undefined" && window.sessionStorage?.getItem(SESSION_KEY) === "1"
    return { permanent, session }
  } catch {
    return { permanent: false, session: false }
  }
}

export default function PWAInstallPrompt({
  interactionCount = 0,
  minInteractions = MIN_INTERACTIONS,
  minDelayMs = MIN_VISIBLE_DELAY_MS,
  onInstalled,
  onDismissed,
  className,
}: PWAInstallPromptProps) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [delayElapsed, setDelayElapsed] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const { permanent, session } = readDismissed()
    if (permanent || session) {
      setDismissed(true)
      return
    }
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalledEvent = () => {
      setDeferred(null)
      setDismissed(true)
      onInstalled?.()
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall)
    window.addEventListener("appinstalled", onInstalledEvent)
    const t = window.setTimeout(() => setDelayElapsed(true), minDelayMs)
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall)
      window.removeEventListener("appinstalled", onInstalledEvent)
      window.clearTimeout(t)
    }
  }, [minDelayMs, onInstalled])

  const handleInstall = useCallback(async () => {
    if (!deferred) return
    try {
      await deferred.prompt()
      const result = await deferred.userChoice
      if (result.outcome === "accepted") {
        onInstalled?.()
      } else {
        try {
          window.sessionStorage?.setItem(SESSION_KEY, "1")
        } catch {
          /* ignore */
        }
        onDismissed?.(false)
      }
    } catch {
      /* ignore */
    } finally {
      setDeferred(null)
      setDismissed(true)
    }
  }, [deferred, onInstalled, onDismissed])

  const handleDismiss = useCallback(
    (permanent: boolean) => {
      try {
        if (permanent) window.localStorage?.setItem(DISMISS_KEY, "1")
        else window.sessionStorage?.setItem(SESSION_KEY, "1")
      } catch {
        /* ignore */
      }
      setDismissed(true)
      onDismissed?.(permanent)
    },
    [onDismissed],
  )

  const eligible =
    !dismissed && !!deferred && delayElapsed && interactionCount >= minInteractions

  if (!eligible) return null

  return (
    <div
      role="dialog"
      aria-label="Install Sira GPT app"
      className={
        className ??
        "fixed inset-x-3 bottom-3 z-50 mx-auto max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 sm:bottom-6"
      }
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Install Sira GPT
          </p>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Add to your home screen for faster access and an app-like experience.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => handleDismiss(false)}
          className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => handleDismiss(true)}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Don&apos;t show again
        </button>
        <button
          type="button"
          onClick={handleInstall}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Install
        </button>
      </div>
    </div>
  )
}

export { PWAInstallPrompt }
