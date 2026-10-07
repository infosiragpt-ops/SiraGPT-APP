"use client"

/**
 * /admin error boundary. reset() remounts the admin segment.
 *
 * A tab that kept running the previous deployment cannot load the new admin
 * chunks («No se pudo cargar el admin» after every publish): that is a
 * stale-bundle error, so it reloads once automatically through the shared
 * guard instead of asking the operator to retry a render that cannot succeed.
 * Every other error is reported to the client telemetry pipeline, which the
 * admin segment used to skip.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Home, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics"
import { reportClientLog } from "@/lib/client-logs"
import { isRecoverableClientBundleError, reloadOnceForStaleBundle } from "@/lib/client-bundle-recovery"

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [attempts, setAttempts] = useState(0)
  const staleBundle = isRecoverableClientBundleError(error)

  useEffect(() => {
    reloadOnceForStaleBundle(error)
  }, [error])

  useEffect(() => {
    try {
      console.warn("[admin] route error", error?.digest || error?.name)
    } catch {
      /* ignore */
    }
    track("error.route", {
      area: "admin",
      digest: error.digest,
      name: error.name,
      message: (error.message || "").slice(0, 500),
      url: typeof window !== "undefined" ? window.location.pathname : "",
    })
    if (staleBundle) return
    reportClientLog({
      source: "render",
      severity: "error",
      action: "error.route",
      component: error.name || "AdminRouteError",
      message: error.message || "Admin render error",
      stack: error.stack,
      extra: { area: "admin", ...(error.digest ? { digest: error.digest } : {}) },
    })
  }, [error, staleBundle])

  const handleRetry = useCallback(() => {
    if (staleBundle) {
      window.location.reload()
      return
    }
    setAttempts((n) => n + 1)
    reset()
  }, [reset, staleBundle])

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <div className="mx-auto max-w-md rounded-xl border border-border/60 bg-card p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">
          {staleBundle ? "Hay una versión nueva de SiraGPT" : "No se pudo cargar el admin"}
        </h1>
        <p className="mb-4 text-sm text-muted-foreground">
          {staleBundle
            ? "Esta pestaña seguía usando la versión anterior. Recarga la página para continuar con la sesión actual."
            : "Ocurrió un error al mostrar esta pantalla de administración. Reintentar remonta la ruta sin perder la sesión."}
        </p>
        {error.digest ? (
          <p className="mb-4 font-mono text-xs text-muted-foreground/60">
            Error ID: {error.digest}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={handleRetry}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            {staleBundle ? "Recargar" : attempts >= 3 ? "Reintentar de nuevo" : "Reintentar"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { window.location.href = "/admin" }}>
            <Home className="mr-1.5 h-4 w-4" />
            Ir a /admin
          </Button>
        </div>
      </div>
    </div>
  )
}
