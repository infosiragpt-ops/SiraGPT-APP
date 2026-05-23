"use client"

import * as React from "react"
import * as Sentry from "@sentry/browser"

import { resolveClientSentryConfig } from "@/lib/sentry-config"

declare global {
  interface Window {
    __SIRA_SENTRY_INITIALIZED__?: boolean
  }
}

export function SentryClientInit() {
  React.useEffect(() => {
    if (window.__SIRA_SENTRY_INITIALIZED__) return
    const config = resolveClientSentryConfig({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
      tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
      replaySessionSampleRate: process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE,
      replayOnErrorSampleRate: process.env.NEXT_PUBLIC_SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE,
    })
    if (!config) return

    Sentry.init({
      ...config,
      beforeSend(event) {
        if (event.request) {
          delete event.request.cookies
          delete event.request.headers
          delete event.request.data
          delete event.request.query_string
        }
        return event
      },
    })
    window.__SIRA_SENTRY_INITIALIZED__ = true
  }, [])

  return null
}
