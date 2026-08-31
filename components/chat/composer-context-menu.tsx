"use client"

import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  deriveComposerContextSnapshot,
  formatCompactTokens,
  formatUsd,
  resolveDisplayTotalCost,
  type ComposerContextMessage,
  type ComposerContextModel,
} from "@/lib/chat/composer-context-usage"

export function ComposerContextMenu({
  messages,
  selectedModel,
  availableModels,
}: {
  messages: ComposerContextMessage[]
  selectedModel: string
  availableModels: ComposerContextModel[]
}) {
  const snapshot = React.useMemo(
    () => deriveComposerContextSnapshot({ messages, selectedModel, availableModels }),
    [availableModels, messages, selectedModel],
  )
  const usage = snapshot.latestUsage
  const contextLabel = `${formatCompactTokens(snapshot.contextTokens)} / ${formatCompactTokens(snapshot.contextWindow)}`
  const totalCost = resolveDisplayTotalCost(usage)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Ventana de contexto: ${contextLabel}${snapshot.percentage === null ? "" : `, ${snapshot.percentage}%`}`}
          title="Ventana de contexto"
          className="composer-context-trigger"
          data-testid="composer-context-trigger"
        >
          <span
            aria-hidden
            className="composer-context-ring-meter"
            style={{ ["--context-ratio" as string]: String((snapshot.percentage ?? 0) / 100) }}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        collisionPadding={10}
        data-testid="composer-context-menu"
        className="composer-context-menu w-[min(calc(100vw-1.25rem),19rem)] p-0"
      >
        <section aria-label="Ventana de contexto">
          <header className="composer-context-header">
            <span>Ventana de contexto</span>
            <strong data-testid="composer-context-metric">
              {contextLabel}{snapshot.percentage === null ? "" : ` · ${snapshot.percentage}%`}
            </strong>
          </header>
          <div
            className="composer-context-progress"
            role="progressbar"
            aria-label="Uso de la ventana de contexto"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={snapshot.percentage ?? undefined}
            aria-valuetext={snapshot.percentage === null ? "No disponible" : `${snapshot.percentage}%`}
          >
            <span style={{ width: `${snapshot.percentage ?? 0}%` }} />
          </div>

          <div className="composer-context-section">
            <h3>Tokens de la ejecución más reciente</h3>
            <p>
              Entrada <strong>{formatCompactTokens(usage?.tokensIn)}</strong>
              <span aria-hidden> · </span>
              Salida <strong>{formatCompactTokens(usage?.tokensOut)}</strong>
              <span aria-hidden> · </span>
            </p>
            <p>Costo est. <strong>{formatUsd(totalCost)}</strong></p>
          </div>

          <div className="composer-context-section composer-context-costs">
            <h3>Costo por tipo</h3>
            <p>
              Entrada <strong>{formatUsd(usage?.costInputUsd)}</strong>
              <span aria-hidden> · </span>
              Salida <strong>{formatUsd(usage?.costOutputUsd)}</strong>
              <span aria-hidden> · </span>
            </p>
            <p>Lectura de caché <strong>{formatUsd(usage?.costCacheReadUsd)}</strong></p>
          </div>
        </section>
      </PopoverContent>
    </Popover>
  )
}
