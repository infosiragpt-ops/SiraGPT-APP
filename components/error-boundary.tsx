"use client"

import { Component, ErrorInfo, ReactNode } from "react"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics"

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
    // Always emit a structured analytics event before the optional
    // onError side-channel so PostHog dashboards can track which
    // boundary labels are firing without each parent having to wire
    // the call themselves. The analytics façade is no-op-safe when
    // PostHog is disabled (NEXT_PUBLIC_POSTHOG_KEY unset), so this
    // costs nothing in dev / closed-source deploys.
    track("error.client_boundary", {
      label,
      // Cap message + name so a runaway error string doesn't blow
      // up the analytics payload. Component stack is intentionally
      // NOT included — it can leak file paths and is bulky; Sentry
      // already captures it via SentryClientInit.
      name: error.name,
      message: (error.message || "").slice(0, 500),
    })
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

    // In production, hide raw error.message — it can leak internal
     // implementation details (stack frames, library internals, PII
     // baked into thrown strings). In dev we surface it verbatim so
     // engineers can debug without opening devtools. The test suite
     // depends on the dev path emitting error.message, so we keep
     // that branch stable. Next.js sets NODE_ENV at build time.
     const isProd = typeof process !== "undefined" && process.env?.NODE_ENV === "production"
     // In production we still want a small diagnostic breadcrumb so the
     // user can tell us WHICH boundary failed and WHICH error class fired
     // when they paste a screenshot. We deliberately omit error.message
     // (can leak PII / stack frames) and keep just the React error name
     // + our human label. The full error is in Sentry / console.
     const label = this.props.label ?? "ErrorBoundary"
     const errName = error.name || "Error"
     const detail = isProd
       ? `Ha ocurrido un error inesperado. Por favor recarga la página. [${label} · ${errName}]`
       : (error.message || "Error desconocido")

     return (
       <div className="my-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
         <div className="flex items-start gap-2">
           <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
           <div className="flex-1 min-w-0">
             <div className="font-medium text-destructive">
               No se pudo renderizar este contenido
             </div>
             <div className="mt-0.5 text-xs text-muted-foreground break-words">
               {detail}
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
