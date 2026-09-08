"use client"

import { useCallback, useEffect } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    try { console.warn("[route] error", error?.digest || error?.name) } catch { /* ignore */ }
  }, [error])
  const handleRetry = useCallback(() => { reset() }, [reset])
  return (
    <div className="flex min-h-[40vh] items-center justify-center p-4">
      <div className="mx-auto max-w-md rounded-xl border border-border/60 bg-card p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">No se pudo cargar esta pagina</h1>
        <p className="mb-4 text-sm text-muted-foreground">Ha ocurrido un error inesperado. Puedes reintentar sin perder el resto de la sesion.</p>
        <Button type="button" onClick={handleRetry} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Reintentar
        </Button>
      </div>
    </div>
  )
}
