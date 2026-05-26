"use client"

// ──────────────────────────────────────────────────────────────
// siraGPT — Route Segment Error UI
// ──────────────────────────────────────────────────────────────
// Next.js automatically wraps each route segment in an
// <ErrorBoundary>. This file provides the fallback UI shown when
// a route (or any of its nested children) throws during render,
// hydration, or a server component error.
//
// Three actions available:
//   1. "Try again"  → resets the error boundary (re-renders)
//   2. "Go home"    → navigates to /
//   3. "Report"     → opens the support channel
//
// After 3 consecutive errors on the same route the "try again"
// button is downgraded to a hint that a reload is needed.
// ──────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Home, RefreshCw, Bug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { track } from "@/lib/analytics"

export const dynamic = "force-static"
export const revalidate = false

// Errors that mean "this tab is running JS from a previous deployment".
// The only safe recovery is a hard reload to fetch the new bundle —
// `reset()` re-renders with the same stale chunks and loops forever.
function isStaleDeploymentError(err: Error & { digest?: string }): boolean {
  const msg = (err.message || "") + " " + (err.digest || "")
  return (
    /Failed to find Server Action/i.test(msg) ||
    /ChunkLoadError/i.test(err.name || "") ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /Loading CSS chunk/i.test(msg)
  )
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()
  const [attempts, setAttempts] = useState(0)
  const [canRetry, setCanRetry] = useState(true)

  // Stale-deployment errors: hard-reload once automatically so the user
  // gets the new bundle without seeing this screen at all. We guard
  // with sessionStorage AND version the guard key by Next.js build ID,
  // so:
  //  - within the same deployment, a broken build can't infinite-loop
  //    reload (we only reload once per (tab, build) pair);
  //  - after a NEW deployment, the build ID changes and the user gets
  //    one fresh auto-reload chance again instead of being stuck on
  //    the error screen for the rest of the tab's lifetime.
  useEffect(() => {
    if (!isStaleDeploymentError(error)) return
    if (typeof window === "undefined") return
    try {
      const buildId = (window as unknown as { __NEXT_DATA__?: { buildId?: string } })
        .__NEXT_DATA__?.buildId || "unknown"
      const KEY = `__siragpt_stale_reload__:${buildId}`
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, String(Date.now()))
        window.location.reload()
      }
    } catch {
      /* sessionStorage unavailable (private mode) — fall through to UI */
    }
  }, [error])

  // Track the error in analytics once on mount
  useEffect(() => {
    track("error.route", {
      digest: error.digest,
      name: error.name,
      message: (error.message || "").slice(0, 500),
      url: typeof window !== "undefined" ? window.location.pathname : "",
    })
  }, [error])

  const handleRetry = useCallback(() => {
    const next = attempts + 1
    setAttempts(next)
    if (next >= 3) {
      setCanRetry(false)
      // After 3 failed retries, suggest a hard reload
      return
    }
    reset()
  }, [attempts, reset])

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <Card className="mx-auto max-w-md p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>

        <h1 className="mb-2 text-xl font-semibold">
          Algo salió mal
        </h1>

        <p className="mb-4 text-sm text-muted-foreground">
          {canRetry
            ? "Ocurrió un error inesperado al cargar esta página. Puedes intentar de nuevo."
            : "El error persistió después de varios intentos. Recarga la página o vuelve al inicio."}
        </p>

        {error.digest && (
          <p className="mb-4 text-xs text-muted-foreground/60 font-mono">
            Error ID: {error.digest}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleRetry}
            disabled={!canRetry}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" />
            {canRetry ? "Intentar de nuevo" : "Recargar página"}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.push("/")}
          >
            <Home className="mr-1.5 h-4 w-4" />
            Ir al inicio
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              window.open("mailto:soporte@siragpt.com?subject=Error%20en%20la%20aplicaci%C3%B3n", "_blank")
            }}
          >
            <Bug className="mr-1.5 h-4 w-4" />
            Reportar
          </Button>
        </div>
      </Card>
    </div>
  )
}
