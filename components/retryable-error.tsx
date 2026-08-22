"use client"

/**
 * RetryableError — reusable "recoverable error" pattern (Frente 1, UX móvil).
 *
 * Un banner accesible que muestra QUÉ falló y ofrece dos salidas:
 *   · "Reintentar"  → repite EXACTAMENTE la última acción (misma función,
 *                     mismo payload — el caller pasa su propio closure).
 *   · "Descartar"   → sale limpio (cierra el banner / limpia el estado).
 *
 * Mobile-first: layout en columna a <420px, touch targets ≥40px, texto
 * fluido; funciona a 320px sin overflow horizontal.
 *
 * Sin librerías nuevas: Button de ui/button + iconos lucide-react ya
 * presentes en el repo. `role="alert"` anuncia el error vía screen readers
 * (assertive live region). El botón Reintentar muestra spinner mientras
 * la acción está en curso (`retrying`) y queda deshabilitado para evitar
 * dobles envíos.
 */

import * as React from "react"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type RetryableErrorProps = {
  /** Mensaje claro del qué falló (ya normalizado/en español por el caller). */
  message: string
  /** Repite exactamente la última acción. Puede ser async; se ignora si ya hay un reintento en curso. */
  onRetry: () => void | Promise<void>
  /** Salida limpia del estado de error (quita el banner, limpia chips, etc.). */
  onDiscard?: () => void
  /** Texto del CTA principal (default "Reintentar"). */
  retryLabel?: string
  /** Texto del CTA secundario (default "Descartar"); oculto si es undefined el handler. */
  discardLabel?: string
  /** Texto visible mientras el reintento corre (default "Reintentando…"). */
  retryingLabel?: string
  className?: string
}

export function RetryableError({
  message,
  onRetry,
  onDiscard,
  retryLabel = "Reintentar",
  discardLabel = "Descartar",
  retryingLabel = "Reintentando…",
  className,
}: RetryableErrorProps) {
  const [retrying, setRetrying] = React.useState(false)

  const handleRetry = React.useCallback(async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      // El caller normalmente quita este banner al tener éxito o al fallar de
      // nuevo; si sigue montado, vuelve a estar disponible para reintentar.
      setRetrying(false)
    }
  }, [onRetry, retrying])

  return (
    <div
      role="alert"
      data-testid="retryable-error"
      className={cn(
        "flex w-full max-w-full flex-col gap-2 rounded-lg border border-red-300/60 bg-red-500/10 p-3",
        "dark:border-red-700/50 dark:bg-red-500/10 sm:flex-row sm:items-center sm:gap-3",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
        <p className="min-w-0 break-words text-sm font-medium leading-snug text-red-600 dark:text-red-300">
          {message}
        </p>
      </div>
      <div className="flex shrink-0 flex-row items-center gap-1.5 self-stretch sm:self-auto">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleRetry()}
          disabled={retrying}
          aria-label={retrying ? retryingLabel : retryLabel}
          className="h-10 min-h-[40px] flex-1 gap-1.5 px-3 text-[13px] font-semibold hover:bg-primary/90 sm:h-9 sm:min-h-0 sm:flex-none"
        >
          {retrying ? (
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {retrying ? retryingLabel : retryLabel}
        </Button>
        {onDiscard ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={retrying}
            aria-label={discardLabel}
            className="h-10 min-h-[40px] flex-1 gap-1 px-2.5 text-[13px] text-muted-foreground hover:text-foreground sm:h-9 sm:min-h-0 sm:flex-none"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {discardLabel}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default RetryableError
