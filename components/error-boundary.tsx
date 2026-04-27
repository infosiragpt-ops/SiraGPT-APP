"use client"

import { Component, ErrorInfo, ReactNode } from "react"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ErrorBoundaryProps {
  children: ReactNode
  // Optional render-prop fallback. Receives the captured error and a
  // reset() that clears the boundary so the subtree can re-mount.
  fallback?: (error: Error, reset: () => void) => ReactNode
  // Optional side-channel for telemetry (e.g. Sentry, posthog).
  onError?: (error: Error, info: ErrorInfo) => void
  // Human label included in console + default fallback so the bad
  // subtree is identifiable in production logs.
  label?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

// React's only supported way to catch render-time errors in children
// is a class component implementing getDerivedStateFromError +
// componentDidCatch. Hooks cannot do this. Wrap any subtree whose
// failure should not bring down the whole page (per-message renders,
// document viewers, plotly/mermaid blocks, etc.).
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const label = this.props.label ?? "ErrorBoundary"
    console.error(`[${label}] caught render error:`, error, info.componentStack)
    this.props.onError?.(error, info)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset)
    }

    return (
      <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-destructive">
              No se pudo renderizar este contenido
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground break-words">
              {error.message || "Error desconocido"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={this.reset}
            className="h-7 px-2 text-xs shrink-0"
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            Reintentar
          </Button>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
