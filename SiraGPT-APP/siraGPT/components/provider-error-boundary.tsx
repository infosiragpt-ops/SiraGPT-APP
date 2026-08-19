"use client"

import { Component, ErrorInfo, ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ProviderErrorBoundaryProps {
  children: ReactNode
  name: string
}

interface ProviderErrorBoundaryState {
  error: Error | null
}

/**
 * ProviderErrorBoundary — Catches crashes in context providers so
 * the rest of the UI stays functional. If a non-critical provider
 * (e.g. analytics, settings) crashes, the app still works. For
 * critical providers (auth, chat), offers a retry button.
 */
export class ProviderErrorBoundary extends Component<
  ProviderErrorBoundaryProps,
  ProviderErrorBoundaryState
> {
  state: ProviderErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ProviderErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ProviderErrorBoundary:${this.props.name}]`, error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    const { name, children } = this.props

    if (!error) return children

    return (
      <div className="flex flex-col items-center justify-center min-h-[200px] p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-destructive mb-3" />
        <h3 className="text-lg font-semibold mb-1">
          Error en {name}
        </h3>
        <p className="text-sm text-muted-foreground mb-4 max-w-md">
          Un componente interno falló. La aplicación puede funcionar con funcionalidad limitada.
        </p>
        <div className="text-xs text-muted-foreground/60 mb-4 font-mono max-w-lg break-words">
          {error.message || "Error desconocido"}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={this.reset}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Reintentar
        </Button>
      </div>
    )
  }
}

/**
 * createProviderGuard — Wraps a provider component with an error
 * boundary so a crash in one provider doesn't cascade.
 *
 * Usage (in app-wrapper.tsx):
 *   <ProviderErrorBoundary name="Chat" fallback={<MinimalUI/>}>
 *     <ChatProvider>...</ChatProvider>
 *   </ProviderErrorBoundary>
 */
export function createProviderGuard(name: string, fallback?: ReactNode) {
  return function ProviderGuard({ children }: { children: ReactNode }) {
    return (
      <ProviderErrorBoundary name={name}>
        {children}
      </ProviderErrorBoundary>
    )
  }
}

export default ProviderErrorBoundary
