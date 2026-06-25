"use client"

import * as React from "react"
import { getNormalizedApiBaseUrl } from "@/lib/api"

export type BackendReadyState = "checking" | "ready" | "warming"

/**
 * Reports whether the Express backend is accepting requests yet.
 *
 * Right after a publish the Next.js frontend goes live ~90s before the backend
 * finishes booting (migrations + plugins + DB). During that window every
 * `/api/*` call is proxied to a backend that isn't listening, so the Next.js
 * rewrite returns a raw 500 — which is what users saw as "Internal Server
 * Error" when clicking "Continuar con Google".
 *
 * This polls the Next.js-served readiness probe (HEAD /api/health/ready, which
 * pings the backend's /health/live and returns 204 when up / 503 while
 * warming). The probe is served by Next.js itself (filesystem route beats the
 * afterFiles /api/:path* rewrite), so it never returns the raw proxy 500 and is
 * safe to poll during the warmup window.
 *
 * Returns "checking" before the first probe resolves, "ready" once the backend
 * answers, and "warming" while it is still booting. Polling stops as soon as
 * the backend is ready.
 */
export function useBackendReady(pollMs = 2500): BackendReadyState {
  const [state, setState] = React.useState<BackendReadyState>("checking")

  React.useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let consecutiveFailures = 0
    // A single slow/aborted probe (cold-start route compile, a GC pause, a
    // transient network blip, the first probe of a fresh page load) must NOT
    // flip the UI to the alarming "El servidor se está iniciando" banner —
    // that produced a persistent false positive even though the backend was
    // healthy. Only declare "warming" after this many *consecutive* failures,
    // so the banner reflects a genuinely unreachable backend (the real
    // post-publish warmup window, where probes fail repeatedly) instead of one
    // unlucky request. We stay in "checking" (no banner) until then.
    const FAILURES_BEFORE_WARMING = 2

    const check = async () => {
      let ready = false
      const controller = new AbortController()
      // Abort a stalled probe so a hung request can't pin the hook in
      // "checking"/"warming" forever; the next poll tick retries cleanly.
      const abortTimer = setTimeout(() => controller.abort(), 7000)
      try {
        const res = await fetch(`${getNormalizedApiBaseUrl()}/health/ready`, {
          method: "HEAD",
          cache: "no-store",
          signal: controller.signal,
        })
        // 204 when the backend is live, 503 while it is still warming up.
        ready = res.ok
      } catch {
        ready = false
      } finally {
        clearTimeout(abortTimer)
      }

      if (!active) return

      if (ready) {
        consecutiveFailures = 0
        setState("ready")
        return
      }

      consecutiveFailures += 1
      if (consecutiveFailures >= FAILURES_BEFORE_WARMING) {
        setState("warming")
      }
      timer = setTimeout(check, pollMs)
    }

    void check()

    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [pollMs])

  return state
}
