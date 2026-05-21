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

  // Track the error in analytics once on mount
  useEffect(() => {
    track("error.route", {
      digest: error.digest,
      name: error.name,
      message: (error.message || "").slice(0, 500),
      url: typeof window !== "undefined" ? window.location.pathname : "",
    })
  }, [error])

  // ── Stale Server Action auto-recovery ───────────────────────
  // "Failed to find Server Action 'x'. This request might be from
  // an older or newer deployment." happens when a user has a tab
  // open across a deploy that changed Server Action hashes. The
  // client bundle holds the old ID, the new server bundle no
  // longer has it. Hard-reload once to pull the new client bundle.
  // sessionStorage guard prevents an infinite reload loop if the
  // underlying cause is actually persistent.
  useEffect(() => {
    if (typeof window === "undefined") return
    const msg = error?.message || ""
    if (!/Failed to find Server Action/i.test(msg)) return
    const guardKey = "__siragpt_sa_reload_guard__"
    if (sessionStorage.getItem(guardKey)) return
    sessionStorage.setItem(guardKey, String(Date.now()))
    window.location.reload()
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
          Algo sali&oacute; mal
        </h1>

        <p className="mb-4 text-sm text-muted-foreground">
          {canRetry
            ? "Ocurri&oacute; un error inesperado al cargar esta p&aacute;gina. Puedes intentar de nuevo."
            : "El error persisti&oacute; despu&eacute;s de varios intentos. Recarga la p&aacute;gina o vuelve al inicio."}
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
            {canRetry ? "Intentar de nuevo" : "Recargar p&aacute;gina"}
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
