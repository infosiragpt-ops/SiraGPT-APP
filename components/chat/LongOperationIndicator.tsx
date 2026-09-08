"use client"

import * as React from "react"
import { X } from "lucide-react"

import { AccessibleIconButton } from "@/components/ui/accessible-icon-button"
import { ThinkingStatusLoader } from "@/components/thinking-status-loader"
import { mapEventToLoaderState } from "@/lib/thinking-loaders"
import { activityTextFromEvent } from "@/lib/live-activity"

export interface LongOperationIndicatorProps {
  active: boolean
  label?: string
  event?: {
    type?: string
    text?: string
    label?: string
    tool?: string
    name?: string
    step?: string
    stage?: string
  } | null
  slowThresholdMs?: number
  onCancel?: () => void
}

export function LongOperationIndicator({
  active,
  label = "Generando…",
  event,
  slowThresholdMs = 30_000,
  onCancel,
}: LongOperationIndicatorProps) {
  // OLA200_WAVE_F FE-038: F4/tool label without moving the indicator.
  const resolvedLabel = event ? activityTextFromEvent(event) : label
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
      <ThinkingStatusLoader
        state={mapEventToLoaderState({
          label: resolvedLabel,
          tool: event?.tool || event?.name,
          text: event?.text,
        })}
        hideLabel
        compact
        density="glyph"
        announce={false}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-foreground">{resolvedLabel}</span>
        <span className={slow ? "text-amber-600" : "text-muted-foreground"}>
          {seconds}s
          {slow && " · está tardando más de lo habitual"}
        </span>
      </div>
      {onCancel ? (
        <AccessibleIconButton
          label="Cancelar operación"
          onClick={onCancel}
          className="ml-1"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </AccessibleIconButton>
      ) : null}
    </div>
  )
}

export default LongOperationIndicator
