"use client"

/**
 * /chat error boundary. reset() remounts ChatInterfaceEnhanced.
 * conversationId lives in the URL, so remounting does not lose the thread.
 */

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Home, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    try {
      console.warn("[chat] route error", error?.digest || error?.name)
    } catch {
      /* ignore */
    }
  }, [error])

  const handleRetry = useCallback(() => {
    setAttempts((n) => n + 1)
    reset()
  }, [reset])

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-4">
      <div className="mx-auto max-w-md rounded-xl border border-border/60 bg-card p-6 text-center shadow-lg">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">No se pudo cargar el chat</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          Ocurrió un error al mostrar esta conversación. El hilo no se pierde:
          reintentar remonta el chat en la misma URL.
        </p>
        {error.digest ? (
          <p className="mb-4 font-mono text-xs text-muted-foreground/60">
            Error ID: {error.digest}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={handleRetry}>
            <RefreshCw className="mr-1.5 h-4 w-4" />
            {attempts >= 3 ? "Reintentar de nuevo" : "Reintentar"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { window.location.href = "/chat" }}>
            <Home className="mr-1.5 h-4 w-4" />
            Ir a /chat
          </Button>
        </div>
      </div>
    </div>
  )
}
