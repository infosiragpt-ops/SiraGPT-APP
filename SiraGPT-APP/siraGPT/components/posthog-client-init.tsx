"use client"

/**
 * PostHogClientInit — boots `posthog-js` exactly once, on the client,
 * iff `NEXT_PUBLIC_POSTHOG_KEY` is present. Mirrors `SentryClientInit`
 * so all observability bootstrap lives in `app/layout.tsx` next to
 * each other and uses the same idempotency pattern (a window-scoped
 * sentinel guard).
 *
 * Why a separate component instead of inline `useEffect` in layout:
 *   layout.tsx is server-rendered (`async function RootLayout`).
 *   A "use client" import nested inside it doesn't pollute the layout
 *   itself with a client boundary; only this component lives on the
 *   client. Same trick layout already uses for Sentry.
 *
 * Privacy posture:
 *   - `disable_session_recording: true` until we explicitly enable
 *     replays, since they capture DOM mutations (PII risk).
 *   - `respect_dnt: true` honors the browser's Do-Not-Track header.
 *   - `persistence: 'localStorage+cookie'` keeps the distinct id
 *     stable across reloads but bound to the user's browser; no
 *     cross-site fingerprinting.
 *   - `autocapture: false` — we capture explicit, named events from
 *     `lib/analytics.ts` only. Autocapture is noisy and can record
 *     button labels that include user data.
 */

import * as React from "react"

declare global {
  interface Window {
    __SIRA_POSTHOG_INITIALIZED__?: boolean
  }
}

export function PostHogClientInit() {
  React.useEffect(() => {
    if (typeof window === "undefined") return
    if (window.__SIRA_POSTHOG_INITIALIZED__) return

    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key) return

    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com"

    // Dynamic import keeps the SDK out of the SSR bundle and lets
    // the browser fetch it on a separate chunk only when analytics
    // is actually enabled.
    void import("posthog-js")
      .then(({ default: posthog }) => {
        if (window.__SIRA_POSTHOG_INITIALIZED__) return
        posthog.init(key, {
          api_host: host,
          autocapture: false,
          capture_pageview: true,
          capture_pageleave: true,
          disable_session_recording: true,
          respect_dnt: true,
          persistence: "localStorage+cookie",
          // posthog-js attaches itself to window.posthog after init;
          // lib/analytics.ts reads from there so the rest of the app
          // never touches the SDK directly.
          loaded: () => {
            window.__SIRA_POSTHOG_INITIALIZED__ = true
          },
        })
      })
      .catch(() => {
        // Analytics bootstrap is never fatal. A failed dynamic import
        // (network blip, ad blocker) just leaves track() as a no-op.
      })
  }, [])

  return null
}
