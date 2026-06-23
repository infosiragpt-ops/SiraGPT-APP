"use client"

import React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  analyzePastedContent,
  getKindLabel,
  getKindIcon,
  getLanguageLabel,
  type PasteCaptureResult,
  type PasteCaptureAction,
} from "@/lib/paste-capture"

type PastePreviewOverlayProps = {
  result: PasteCaptureResult
  onAction: (action: PasteCaptureAction, result: PasteCaptureResult) => void
  visible: boolean
}

function StatPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <span className="text-[12px] font-semibold tabular-nums text-foreground">
        {typeof value === "number" ? Intl.NumberFormat("es").format(value) : value}
      </span>
    </div>
  )
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString("es")
}

export function PastePreviewOverlay({ result, onAction, visible }: PastePreviewOverlayProps) {
  const [animateIn, setAnimateIn] = React.useState(false)
  const [animateOut, setAnimateOut] = React.useState(false)
  const [selectedAction, setSelectedAction] = React.useState<PasteCaptureAction>(
    result.suggestedAction
  )
  const [dismissed, setDismissed] = React.useState(false)
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (visible && !dismissed) {
      requestAnimationFrame(() => {
        setAnimateIn(true)
        setTimeout(() => {
          if (confirmRef.current) confirmRef.current.focus()
        }, 260)
      })
    }
  }, [visible, dismissed])

  React.useEffect(() => {
    setSelectedAction(result.suggestedAction)
    setDismissed(false)
    setAnimateOut(false)
  }, [result])

  React.useEffect(() => {
    if (!visible || dismissed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        handleAction("cancel")
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
        handleAction(selectedAction)
      }
      if (e.key === "Tab") {
        e.preventDefault()
        setSelectedAction(prev =>
          prev === "attach_document" ? "insert_text" : "attach_document"
        )
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })

  const handleAction = React.useCallback(
    (action: PasteCaptureAction) => {
      setAnimateOut(true)
      setAnimateIn(false)
      setTimeout(() => {
        setDismissed(true)
        onAction(action, result)
      }, 220)
    },
    [onAction, result]
  )

  if (!visible || dismissed) return null

  const {
    contentKind,
    contentKindDetection,
    naturalLanguage,
    charCount,
    wordCount,
    lineCount,
    sentenceCount,
    paragraphCount,
    structuralScore,
    estimatedTokens,
    estimatedReadingMinutes,
    estimatedPages,
    preview,
    previewTruncated,
    title,
    suggestedFilename,
    processingMs,
  } = result

  const kindLabel = getKindLabel(contentKind)
  const kindIcon = getKindIcon(contentKind)
  const langLabel = getLanguageLabel(naturalLanguage)
  const confidence = contentKindDetection.confidence
  const isCode = contentKind === "code"
  const codeLang = isCode ? contentKindDetection.language : undefined

  return (
    <div
      className={cn(
        "pointer-events-auto absolute inset-x-0 bottom-full z-50 mb-2 px-2",
        "transition-all duration-base ease-soft",
        animateIn && !animateOut
          ? "opacity-100 translate-y-0"
          : "opacity-0 translate-y-3",
      )}
    >
      <div
        className={cn(
          "mx-auto max-w-2xl overflow-hidden rounded-2xl",
          "border border-border/60",
          "bg-background/98 backdrop-blur-xl",
          "shadow-[0_8px_32px_-8px_rgba(15,23,42,0.18),0_2px_8px_-2px_rgba(15,23,42,0.08)]",
          "dark:shadow-[0_12px_40px_-12px_rgba(0,0,0,0.55),0_4px_12px_-4px_rgba(0,0,0,0.3)]",
        )}
      >
        <div className="p-4">
          <div className="mb-3 flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted/80 text-lg">
              {kindIcon}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[14px] font-semibold leading-tight text-foreground">
                {title}
              </h3>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className="h-[22px] gap-1 rounded-md px-2 text-[10.5px] font-medium uppercase tracking-wider"
                >
                  {kindLabel}
                  {isCode && codeLang && (
                    <span className="ml-0.5 text-muted-foreground">({codeLang})</span>
                  )}
                </Badge>
                {langLabel && (
                  <Badge
                    variant="outline"
                    className="h-[22px] rounded-md px-2 text-[10.5px] font-medium"
                  >
                    {langLabel}
                  </Badge>
                )}
                {confidence >= 0.85 && (
                  <Badge
                    variant="outline"
                    className="h-[22px] gap-1 rounded-md border-emerald-300 bg-emerald-50 px-2 text-[10.5px] font-medium text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-900/20 dark:text-emerald-400"
                  >
                    Alta confianza
                  </Badge>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleAction("cancel")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/80 hover:text-foreground"
              aria-label="Cancelar (Esc)"
              title="Cancelar (Esc)"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M2 2l10 10M12 2L2 12" />
              </svg>
            </button>
          </div>

          <div className="mb-3 overflow-hidden rounded-xl border border-border/50 bg-muted/30">
            <div className="flex items-center justify-between border-b border-border/30 px-3 py-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Vista previa
              </span>
              {suggestedFilename && (
                <span className="max-w-[180px] truncate text-[10px] text-muted-foreground/50">
                  {suggestedFilename}
                </span>
              )}
            </div>
            <pre
              className={cn(
                "max-h-28 overflow-hidden px-3 py-2.5 text-[12px] leading-[1.55]",
                "font-mono text-foreground/85",
                "whitespace-pre-wrap break-words",
              )}
            >
              {preview}
              {previewTruncated && (
                <span className="text-muted-foreground/60">{"\n"}…</span>
              )}
            </pre>
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            <StatPill label="Car." value={formatNumber(charCount)} />
            {wordCount > 0 && <StatPill label="Pal." value={formatNumber(wordCount)} />}
            <StatPill label="Líneas" value={lineCount} />
            {paragraphCount > 1 && <StatPill label="Párr." value={paragraphCount} />}
            {estimatedTokens > 0 && <StatPill label="~Tokens" value={formatNumber(estimatedTokens)} />}
            {estimatedReadingMinutes > 1 && (
              <StatPill label="Lectura" value={`${estimatedReadingMinutes} min`} />
            )}
            {estimatedPages > 1 && <StatPill label="~Págs." value={estimatedPages} />}
            {structuralScore >= 2 && (
              <StatPill label="Estructura" value={`${structuralScore}/7`} />
            )}
          </div>

          <div className="mb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setSelectedAction("attach_document")}
              className={cn(
                "flex-1 rounded-xl px-3 py-2.5 text-left transition-all duration-200",
                "border",
                selectedAction === "attach_document"
                  ? "border-foreground/20 bg-foreground/[0.06] text-foreground shadow-sm dark:border-foreground/30 dark:bg-foreground/[0.08]"
                  : "border-border/50 bg-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <div className="mb-0.5 text-[13px] font-semibold">
                📎 Adjuntar como documento
              </div>
              <div className="text-[10.5px] leading-tight text-muted-foreground/80">
                Se analiza con inteligencia documental, RAG e indexación
              </div>
            </button>
            <button
              type="button"
              onClick={() => setSelectedAction("insert_text")}
              className={cn(
                "flex-1 rounded-xl px-3 py-2.5 text-left transition-all duration-200",
                "border",
                selectedAction === "insert_text"
                  ? "border-foreground/20 bg-foreground/[0.06] text-foreground shadow-sm dark:border-foreground/30 dark:bg-foreground/[0.08]"
                  : "border-border/50 bg-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
              )}
            >
              <div className="mb-0.5 text-[13px] font-semibold">
                ✏️ Insertar como texto
              </div>
              <div className="text-[10.5px] leading-tight text-muted-foreground/80">
                Se pega directamente en el campo de entrada
              </div>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <Button
              ref={confirmRef}
              onClick={() => handleAction(selectedAction)}
              className={cn(
                "flex-1 h-10 rounded-xl text-[13px] font-semibold",
                "transition-all duration-200",
                selectedAction === "attach_document"
                  ? "bg-foreground text-background hover:bg-foreground/90 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_4px_12px_-2px_rgba(0,0,0,0.18)]"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/80",
              )}
            >
              {selectedAction === "attach_document"
                ? "Adjuntar documento"
                : "Insertar texto"}
            </Button>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[10px] tabular-nums text-muted-foreground/50">
                {processingMs < 1 ? "<1ms" : `${Math.round(processingMs)}ms`}
              </span>
              <span className="text-[9px] text-muted-foreground/40">
                Enter · Esc · Tab
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function usePasteCapture(
  onAction: (action: PasteCaptureAction, result: PasteCaptureResult) => void
) {
  const [captureResult, setCaptureResult] = React.useState<PasteCaptureResult | null>(null)
  const [overlayVisible, setOverlayVisible] = React.useState(false)

  const capture = React.useCallback((rawText: string) => {
    const result = analyzePastedContent(rawText)
    setCaptureResult(result)
    setOverlayVisible(true)
    return result
  }, [])

  const handleAction = React.useCallback(
    (action: PasteCaptureAction, result: PasteCaptureResult) => {
      setOverlayVisible(false)
      setTimeout(() => setCaptureResult(null), 300)
      onAction(action, result)
    },
    [onAction]
  )

  const dismiss = React.useCallback(() => {
    setOverlayVisible(false)
    setTimeout(() => setCaptureResult(null), 300)
  }, [])

  return {
    captureResult,
    overlayVisible,
    capture,
    handleAction,
    dismiss,
    Overlay: captureResult ? (
      <PastePreviewOverlay
        result={captureResult}
        onAction={handleAction}
        visible={overlayVisible}
      />
    ) : null,
  }
}
