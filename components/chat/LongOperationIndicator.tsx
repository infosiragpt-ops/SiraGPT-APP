"use client"

import * as React from "react"
import { X } from "lucide-react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"

export interface LongOperationIndicatorProps {
  active: boolean
  label?: string
  slowThresholdMs?: number
  onCancel?: () => void
}

export function LongOperationIndicator({
  active,
  label = "Generando…",
  slowThresholdMs = 30_000,
  onCancel,
}: LongOperationIndicatorProps) {
  const [elapsedMs, setElapsedMs] = React.useState(0)

  React.useEffect(() => {
    if (!active) {
      setElapsedMs(0)
      return
    }
    const start = Date.now()
    setElapsedMs(0)
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - start)
    }, 500)
    return () => window.clearInterval(id)
  }, [active])

  if (!active) return null

  const seconds = Math.floor(elapsedMs / 1000)
  const slow = elapsedMs >= slowThresholdMs

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-24 right-4 z-50 flex max-w-[90vw] items-center gap-3 rounded-lg border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur sm:bottom-6 sm:max-w-sm"
    >
      <ThinkingIndicator size="sm" className="text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className={slow ? "text-amber-600" : "text-muted-foreground"}>
          {seconds}s
          {slow && " · está tardando más de lo habitual"}
        </span>
      </div>
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Cancelar operación"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export default LongOperationIndicator
