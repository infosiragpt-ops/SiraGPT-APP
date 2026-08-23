"use client"

/**
 * push-bootstrap — wires the service worker + web-push subscription to the
 * app lifecycle. Mounted once from LayoutClientEffects (ssr:false).
 *
 * What it does, in order:
 *   1. Registers /sw.js (production only) via lib/sw-register.
 *   2. If the user is authenticated (auth-token in localStorage), asks
 *      Notification.permission and subscribes web-push through
 *      lib/notifications/push.subscribe().
 *
 * Deliberate constraints:
 *   - Never prompts on first paint: waits for window load + idle, and only
 *     when a session token exists (permission prompts require a user gesture
 *     in Safari; we accept that Chrome may show it after login navigation).
 *   - All failures are swallowed: notifications are an enhancement and must
 *     never break chat.
 */

import { useEffect } from "react"

import { registerSiraServiceWorker } from "@/lib/sw-register"
import { subscribe } from "@/lib/notifications/push"

const AUTH_TOKEN_KEY = "auth-token"
const SUBSCRIBED_KEY = "siragpt.push.subscribed"

function hasSessionToken(): boolean {
  try {
    return !!window.localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    return false
  }
}

function markSubscribed(): void {
  try {
    window.localStorage.setItem(SUBSCRIBED_KEY, "1")
  } catch {
    /* ignore */
  }
}

export function PushBootstrap() {
  useEffect(() => {
    // 1) Service worker — required for both offline fallback and push.
    registerSiraServiceWorker()

    if (!hasSessionToken()) return
    if (typeof Notification === "undefined" || !("PushManager" in window)) return

    // 2) Web-push subscription. Only ask permission when the browser has no
    //    stored decision yet or already granted it; never nag a denial.
    if (Notification.permission === "denied") return
    let alreadySubscribed = false
    try {
      alreadySubscribed = window.localStorage.getItem(SUBSCRIBED_KEY) === "1"
    } catch {
      /* ignore */
    }
    if (Notification.permission === "default" && alreadySubscribed) return

    const start = () => {
      // Idle callback keeps the permission prompt off the critical path.
      subscribe()
        .then((result) => {
          if (result?.ok) markSubscribed()
        })
        .catch(() => {
          /* best-effort */
        })
    }
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => start(), { timeout: 30_000 })
    } else {
      setTimeout(start, 3_000)
    }
  }, [])

  return null
}
